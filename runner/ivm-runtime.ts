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

  private async run(code: string) {
    const s = await this.isolate.compileScript(code);
    return s.run(this.context, { timeout: this.timeoutMs });
  }

  async init(botJs: string) {
    this.context = await this.isolate.createContext();
    const jail = this.context.global;

    // глобал и консоль
    await jail.set('global', jail.derefInto());
    await jail.set('_bridgeLog', new ivm.Reference((...a: any[]) => { try { console.log('[ivm]', ...a); } catch {} }));
    await this.run(`const console={log:(...a)=>_bridgeLog.applySync(undefined,a)};`);

    // CJS-окружение вънутри изолята
    await this.run(`
      var module = { exports: {} };
      var exports = module.exports;
      var process = undefined;
      var require = undefined;
    `);

    // выполнить bot.js
    const script = await this.isolate.compileScript(botJs);
    await script.run(this.context, { timeout: this.timeoutMs });

    await this.run(`console.log('ivm: handleUpdate export ready')`);

    // вытащить экспорт
    const exported = await this.context.eval(`module && module.exports && module.exports.handleUpdate`, { timeout: this.timeoutMs });
    if (typeof exported !== 'function') throw new Error('IVM_NO_HANDLE_UPDATE');
    this.handleUpdateRef = new ivm.Reference(exported);
  }

  async handleUpdate(
    ctxObj: any,
    tools: {
      sendMessage: (p:{type:'text';text:string})=>Promise<void>,
      http: (r:{url:string;method?:'GET'|'POST';body?:any})=>Promise<any>,
      goto: (to:string)=>Promise<void>,
      getState:()=>Promise<any>,
      setState:(s:any)=>Promise<void>,
    }
  ) {
    if (!this.handleUpdateRef) throw new Error('IVM_NOT_READY');

    await this.run(`console.log('ivm: update start')`);

    // прокидываем мосты-функции как глобальные Reference
    const g = this.context.global;
    await g.set('_sendMessage', new ivm.Reference((p:any)=>tools.sendMessage(p)));
    await g.set('_http',        new ivm.Reference((r:any)=>tools.http(r)));
    await g.set('_goto',        new ivm.Reference((to:string)=>tools.goto(to)));
    await g.set('_getState',    new ivm.Reference(()=>tools.getState()));
    await g.set('_setState',    new ivm.Reference((s:any)=>tools.setState(s)));

    // скопировать входной ctxHost внутрь изолята
    await g.set('_ctxHost', new ivm.ExternalCopy(ctxObj).copyInto({ release: true }));

    // создать _ctx внутри изолята; методы вызывают host-функции через Reference.apply и возвращают промисы
    const makeCtxSrc = `
      (function(){
        const ctxHost = global._ctxHost;
        var _ctx = {
          botId: ctxHost.botId,
          chat: ctxHost.chat,
          state: ctxHost.state,
          sendMessage: (p) => _sendMessage.apply(undefined, [p], { arguments: { copy: true }, result: { promise: true } }),
          http:        (r) => _http.apply(undefined, [r],        { arguments: { copy: true }, result: { promise: true } }),
          goto:        (to)=> _goto.apply(undefined, [to],       { arguments: { copy: true }, result: { promise: true } }),
          getState:    () => _getState.apply(undefined, [],      { result: { promise: true } }),
          setState:    (s) => _setState.apply(undefined, [s],    { arguments: { copy: true }, result: { promise: true } }),
        };
        global._ctx = _ctx;
        delete global._ctxHost;
      })()
    `;
    const makeCtxScript = await this.isolate.compileScript(makeCtxSrc);
    await makeCtxScript.run(this.context, { timeout: this.timeoutMs });

    // вызвать экспортированный обработчик внутри изолята
    const callScript = await this.isolate.compileScript(`module && module.exports && module.exports.handleUpdate && module.exports.handleUpdate(global._ctx)`);
    return callScript.run(this.context, { timeout: this.timeoutMs });
  }

  dispose() {
    try { this.context.release(); } catch {}
    try { this.isolate.dispose(); } catch {}
  }
}


