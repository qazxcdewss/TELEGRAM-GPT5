// services/gateway/generator.ts
type Step = { type: 'sendMessage'|'goto'|'http'; text?: string; to?: string; url?: string; method?: 'GET'|'POST'; body?: any }
type Flow = { name: string; steps: Step[] }
type Spec = { meta:{ botId:string }, commands?: Array<{cmd:string, flow:string}>, flows: Flow[] }

export function generateBotJs(spec: Spec): string {
  const flows = spec.flows || []
  // небольшой рантайм + таблица шагов
  return `
const commands = ${JSON.stringify(spec.commands || [])};
const flows = ${JSON.stringify(flows)};
function getFlow(name){ return flows.find(f => f.name === name) }
async function httpRequest({url, method='POST', body=null, timeoutMs=5000}) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers:{'content-type':'application/json'}, body: body?JSON.stringify(body):undefined, signal: ctrl.signal });
    const txt = await res.text();
    try { const j = JSON.parse(txt); return { ok: res.ok, status: res.status, json: j, text: txt } } catch { return { ok: res.ok, status: res.status, text: txt } }
  } finally { clearTimeout(t) }
}

module.exports.handleUpdate = async function handleUpdate(ctx){
  const text = (ctx?.message?.text || "").trim();
  const cmd = text.startsWith("/") ? text.split(" ",1)[0] : null;
  let flowName = (commands.find(c => c.cmd === cmd)?.flow) || (flows[0]?.name);
  let flow = getFlow(flowName);
  if (!flow) return { type:"text", text:"Flow not found" };

  for (let i=0;i<flow.steps.length;i++){
    const step = flow.steps[i];

    if (step.type === "sendMessage") {
      await ctx.sendMessage({ type: 'text', text: step.text || '' });
      continue;
    }

    if (step.type === "goto") {
      const next = getFlow(step.to);
      if (!next) return { type:"text", text:"Flow not found: "+step.to };
      flow = next; i = -1; continue; // стартуем новый flow
    }

    if (step.type === "http") {
      const r = await httpRequest({ url: step.url, method: step.method || 'POST', body: step.body ?? null });
      if (!r.ok) return { type:"text", text: "HTTP "+r.status };
      const msg = r?.json?.message ?? r.text ?? "";
      await ctx.sendMessage({ type: 'text', text: String(msg) });
      continue;
    }
  }
  return 'ok';
};
`.trim()
}



