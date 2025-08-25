// runner/ivm-runtime.ts
import ivm from 'isolated-vm';

export type RunnerOptions = { memoryMb?: number; timeoutMs?: number };

export class IVMRunner {
  private isolate: ivm.Isolate;
  private context!: ivm.Context;
  private handleUpdateRef?: ivm.Reference<Function>;
  private timeoutMs: number;

  constructor(opts: RunnerOptions = {}) {
    const memoryMb = Number(process.env.IVM_MEMORY_MB || opts.memoryMb || 64);
    this.timeoutMs = Number(process.env.IVM_TIMEOUT_MS || opts.timeoutMs || 250);
    this.isolate = new ivm.Isolate({ memoryLimit: memoryMb });
  }

  async init(botJs: string) {
    this.context = await this.isolate.createContext();
    const jail = this.context.global;
    await jail.set('global', jail.derefInto());
    await jail.set('module', new ivm.Reference({ exports: {} }));
    await jail.set('exports', new ivm.Reference({}));
    await jail.set('_bridgeLog', new ivm.Reference((...a: any[]) => { try { console.log('[ivm]', ...a); } catch {} }));
    await this.run(`const console={log:(...a)=>_bridgeLog.applySync(undefined,a)}`);
    await this.run(`Object.defineProperty(global,'process',{value:undefined});Object.defineProperty(global,'require',{value:undefined});`);

    const script = await this.isolate.compileScript(botJs);
    await script.run(this.context, { timeout: this.timeoutMs });

    const exported = await this.context.eval(`module.exports && module.exports.handleUpdate`, { timeout: this.timeoutMs });
    if (typeof exported !== 'function') throw new Error('IVM_NO_HANDLE_UPDATE');
    this.handleUpdateRef = new ivm.Reference(exported);
  }

  private async run(code: string) {
    const s = await this.isolate.compileScript(code);
    return s.run(this.context, { timeout: this.timeoutMs });
  }

  async handleUpdate(ctxObj: any, tools: {
    sendMessage: (p:{type:'text';text:string})=>Promise<void>,
    http: (r:{url:string;method?:'GET'|'POST';body?:any})=>Promise<any>,
    goto: (to:string)=>Promise<void>,
    getState:()=>Promise<any>,
    setState:(s:any)=>Promise<void>,
  }) {
    if (!this.handleUpdateRef) throw new Error('IVM_NOT_READY');

    const toolsRef = new ivm.Reference({
      sendMessage: (p:any)=>tools.sendMessage(p),
      http: (r:any)=>tools.http(r),
      goto: (to:string)=>tools.goto(to),
      getState: ()=>tools.getState(),
      setState: (s:any)=>tools.setState(s),
    });

    const makeCtxSrc = `
      (function(ctxHost, toolsHost){
        return {
          botId: ctxHost.botId,
          chat: ctxHost.chat,
          state: ctxHost.state,
          sendMessage: (p)=>toolsHost.sendMessage(p),
          http: (r)=>toolsHost.http(r),
          goto: (to)=>toolsHost.goto(to),
          getState: ()=>toolsHost.getState(),
          setState: (s)=>toolsHost.setState(s),
        };
      })
    `;
    const makeCtxScript = await this.isolate.compileScript(makeCtxSrc);
    const makeCtxFn = await makeCtxScript.run(this.context);
    const ctxRef = await makeCtxFn.apply(this.context, [
      new ivm.ExternalCopy(ctxObj).copyInto({ release: true }),
      toolsRef
    ], { timeout: this.timeoutMs });

    return this.handleUpdateRef.apply(undefined, [ctxRef], { timeout: this.timeoutMs });
  }

  dispose() {
    try { this.context.release(); } catch {}
    try { this.isolate.dispose(); } catch {}
  }
}


