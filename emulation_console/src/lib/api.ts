export const API_BASE =
  (window as any).API || (import.meta as any).env?.VITE_API || 'http://localhost:3000'

async function jsonFetch(path: string, init?: RequestInit) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    credentials: 'include'
  })
  const txt = await res.text()
  const data = txt ? JSON.parse(txt) : null
  if (!res.ok) throw new Error((data?.error?.code || txt || `HTTP_${res.status}`).slice(0, 200))
  return data
}

let activeBotId =
  localStorage.getItem('activeBotId') ||
  (window as any).BOT_ID || (import.meta as any).env?.VITE_BOT_ID || 'my-bot-1'

export function getActiveBotId() { return activeBotId }
export function setActiveBotId(id: string) {
  activeBotId = id
  localStorage.setItem('activeBotId', id)
}

export async function apiFetch(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers || {})
  if (activeBotId) headers.set('x-bot-id', activeBotId)
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers })
  if (!res.ok) {
    const t = await res.text().catch(()=> '')
    throw new Error(t || `HTTP_${res.status}`)
  }
  return res
}

// ——— NL endpoints ———
export type ChatMsg = { role:'user'|'assistant'; text:string }
export async function nlChat(body: { messages: ChatMsg[]; currentSpec?: any; mode?: 'patch'|'full' }) {
  const r = await apiFetch('/api/nl/chat', { method:'POST', body: JSON.stringify(body) })
  return r.json()
}
export async function nlSpec(text: string, currentSpec?: any) {
  const r = await fetch(`${API_BASE}/api/nl/spec`, {
    method:'POST', headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify({ text, currentSpec })
  })
  const tx = await r.text().catch(()=> ''); const j = tx ? JSON.parse(tx) : null
  return { ok: r.ok, status: r.status, data: j }
}

// ——— Spec / Generate / Deploy (1:1 с console) ———
export const uploadSpec   = (botId: string, spec: any) =>
  apiFetch('/spec',    { method:'POST', body: JSON.stringify({ botId, spec }) })
export const generateCode = (body: { botId:string; engine:'local'|'gpt5'; specVersion?: number }) =>
  apiFetch('/generate', { method:'POST', body: JSON.stringify(body) })
export const deployRev    = (botId: string, revHash: string) =>
  apiFetch('/deploy',  { method:'POST', body: JSON.stringify({ botId, revHash }) })

export const listRevisions = (botId: string) => apiFetch(`/revisions?botId=${encodeURIComponent(botId)}`).then(r=>r.json())
export const getBot        = (botId: string) => apiFetch(`/bots/${encodeURIComponent(botId)}`).then(r=>r.json())
export const listBots      = () => jsonFetch('/api/bots', { method:'GET' })
export const createBot     = (botId: string, title?: string) => jsonFetch('/api/bots', { method:'POST', body: JSON.stringify({ botId, title }) })


