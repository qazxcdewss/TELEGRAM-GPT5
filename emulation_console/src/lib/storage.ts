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


