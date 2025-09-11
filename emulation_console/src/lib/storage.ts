const KEY = 'emul.ai.history.v1'
export type SavedState = {
  messages: Array<{ id:string; role:'user'|'assistant'|'system'; text:string; ts:number }>
  draft?: any
}

export const loadState = (): SavedState => {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') } catch { return {} as any }
}
export const saveState = (s: SavedState) => { try { localStorage.setItem(KEY, JSON.stringify(s)) } catch {} }
export const resetState = () => { try { localStorage.removeItem(KEY) } catch {} }

// ——— Per-bot draft helpers ———
const DKEY = (botId: string) => `emul.ai.draft.v1:${botId}`
export function loadDraft(botId: string): any | null {
  try { return JSON.parse(localStorage.getItem(DKEY(botId)) || 'null') } catch { return null }
}
export function saveDraft(botId: string, draft: any) {
  try { localStorage.setItem(DKEY(botId), JSON.stringify(draft)) } catch {}
}
export function resetDraft(botId: string) {
  try { localStorage.removeItem(DKEY(botId)) } catch {}
}


