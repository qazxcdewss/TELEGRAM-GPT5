import { API_BASE } from "./config";

export type ChatMsg = { role: "user"|"assistant"; text: string };

export async function nlChat(messages: ChatMsg[], currentSpec: any|null, mode: "patch"|"full") {
  const r = await fetch(`${API_BASE}/api/nl/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, currentSpec, mode })
  });
  const txt = await r.text();
  let j: any = null; try { j = JSON.parse(txt) } catch {}
  if (!r.ok) throw new Error(j?.error?.code || `HTTP_${r.status}`);
  return j as { assistant?: string, patch?: any[], targetSpec?: any, canonical?: string };
}

export async function simRun(spec: any, message: string, sessionId: string) {
  const r = await fetch(`${API_BASE}/sim/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ spec, message, sessionId })
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error?.code || `HTTP_${r.status}`);
  return j as { replies: string[], state?: any };
}
