export type ChatMsg = { role: 'user'|'assistant'; text: string }
export type NlChatRequest = { messages: ChatMsg[]; currentSpec?: any; mode?: 'patch'|'full' }
export type NlChatResponse = {
  assistant: string
  patch?: Array<{ op: 'add'|'remove'|'replace'; path: string; value?: any }>
  targetSpec?: any
  canonical?: string
}

const API_BASE = (window as any).API || (import.meta as any).env?.VITE_API || 'http://localhost:3000'
export const DEFAULT_BOT = (window as any).BOT_ID || (import.meta as any).env?.VITE_BOT_ID || 'my-bot-1'

async function jsonFetch(path: string, init?: RequestInit) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers||{}) }
  } as RequestInit)
  const text = await res.text()
  let data: any = null; try { data = text ? JSON.parse(text) : null } catch {}
  return { ok: (res as any).ok as boolean, status: (res as any).status as number, data, text }
}

export const postNlChat = (body: NlChatRequest) =>
  jsonFetch('/api/nl/chat', { method:'POST', body: JSON.stringify(body) })

export const postNlSpec = (text: string, currentSpec?: any) =>
  jsonFetch('/api/nl/spec', { method:'POST', body: JSON.stringify({ text, currentSpec }) })

export const getActiveRev = (botId = DEFAULT_BOT) =>
  jsonFetch(`/bots/${encodeURIComponent(botId)}`)


