import { useEffect, useRef, useState } from 'react'
import { nlChat, nlSpec } from '../lib/api'
import { applyPatch, type Op } from '../lib/patch'
import { loadState, saveState, resetState } from '../lib/storage'
import MessageBubble from './MessageBubble'
import ResultCard from './ResultCard'
import TypingDots from './TypingDots'

type UiMsg = { id:string; role:'user'|'assistant'|'system'; text:string; ts:number;
  attachments?: Array<{kind:'patch'|'full-spec'|'draft'; data:any}> }
const rid = () => Math.random().toString(36).slice(2)

export default function AiChatPane() {
  const [messages, setMessages] = useState<UiMsg[]>(() => loadState().messages || [
    { id: rid(), role:'system', text:'Здесь будет чат со спеками / ревизиями. Пока — заглушка.', ts: Date.now() }
  ])
  const [draft, setDraft] = useState<any>(() => loadState().draft || null)
  const [input, setInput] = useState('')
  const [mode, setMode] = useState<'patch'|'full'>('patch')
  const [loading, setLoading] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => { saveState({ messages, draft }) }, [messages, draft])
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = 1e9
  }, [messages.length, loading])

  async function send() {
    const text = input.trim(); if (!text || loading) return
    setInput(''); const now = Date.now()
    setMessages(m => [...m, { id: rid(), role:'user', text, ts: now }]); setLoading(true)

    const history = [...messages, { id: rid(), role:'user', text, ts: now }]
      .filter(m => m.role==='user' || m.role==='assistant').slice(-10)
      .map(m => ({ role: m.role as 'user'|'assistant', text: m.text }))

    try {
      const resp = await nlChat({ messages: history, currentSpec: draft || null, mode })
      const attachments: UiMsg['attachments'] = []
      if (Array.isArray(resp?.patch)) attachments.push({ kind:'patch', data: resp.patch })
      if (resp?.targetSpec) { setDraft(resp.targetSpec); attachments.push({ kind:'full-spec', data: resp.targetSpec }) }
      setMessages(m => [...m, { id: rid(), role:'assistant', text: resp?.assistant || 'Готово.', ts: Date.now(), attachments }])
    } catch (e:any) {
      const r = await nlSpec(text, draft || null)
      if (!r.ok && r.status === 422 && (r.data as any)?.draft) {
        setDraft((r.data as any).draft)
        setMessages(m => [...m, {
          id: rid(), role:'assistant',
          text: (r.data as any)?.assistant || 'Черновик спеки сформирован, но содержит ошибки (AJV).',
          ts: Date.now(),
          attachments: [{ kind:'draft', data: (r.data as any).draft }]
        }])
        setLoading(false); return
      }
      setMessages(m => [...m, { id: rid(), role:'assistant', text: 'Ошибка: '+(e?.message||'NL failed'), ts: Date.now() }])
    } finally {
      setLoading(false)
    }
  }

  function applyPatchLocally(ops: Op[]) {
    try { setDraft((d:any)=>applyPatch(d, ops)) }
    catch (e:any) { alert('Не удалось применить Patch: ' + (e?.message||e)) }
  }

  function useAsDraft(obj:any) { setDraft(obj) }
  function clearAll() { resetState(); setMessages([]); setDraft(null) }

  return (
    <div className="ai-pane" style={{ height:'100%', minHeight:0, display:'grid', gridTemplateRows:'auto 1fr auto', background:'#0b1220', borderRight:'1px solid #1e293b' }}>
      <div className="ai-pane__header" style={{ padding:14, borderBottom:'1px solid #1e293b', display:'flex', gap:12, alignItems:'center' }}>
        <div style={{ fontWeight:700 }}>Spec Assistant</div>
        <div style={{ fontSize:12, color:'#9ca3af' }}>{draft ? 'Draft: in memory (не применён)' : 'Draft: empty'}</div>
        <div style={{ marginLeft:'auto', display:'flex', gap:10 }}>
          <label style={{ fontSize:12, color:'#9ca3af' }}>
            Mode:&nbsp;
            <select value={mode} onChange={e=>setMode(e.target.value as any)}
                    style={{ background:'transparent', color:'#e5e7eb', border:'1px solid #1e293b', borderRadius:8, padding:'4px 8px' }}>
              <option value="patch">Patch</option>
              <option value="full">Full</option>
            </select>
          </label>
          <button className="ai-btn" onClick={clearAll}>Reset</button>
        </div>
      </div>

      <div className="ai-pane__scroll" ref={scrollRef} style={{ overflow:'auto', padding:14, minHeight:0 }}>
        <div style={{ display:'grid', gap:10 }}>
          {messages.map(m => (
            <div key={m.id} style={{ display:'grid', gap:8 }}>
              <MessageBubble role={m.role}>{m.text}</MessageBubble>
              {m.attachments?.map((a, i) => (
                <ResultCard
                  key={i}
                  kind={a.kind}
                  data={a.data}
                  onApplyPatch={a.kind==='patch' ? ()=>applyPatchLocally(a.data as Op[]) : undefined}
                  onUseDraft={a.kind!=='patch' ? (v)=>useAsDraft(v) : undefined}
                />
              ))}
            </div>
          ))}
          {loading && <MessageBubble role="assistant"><TypingDots/></MessageBubble>}
        </div>
      </div>

      <div className="ai-pane__input" style={{ padding:12, borderTop:'1px solid #1e293b', display:'grid', gap:8 }}>
        <div style={{ display:'flex', gap:8 }}>
          <input
            placeholder="Опиши идею бота, команды, сценарии…"
            value={input}
            onChange={e=>setInput(e.target.value)}
            onKeyDown={e=>{ if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
            style={{ flex:1, background:'#0f172a', border:'1px solid #1e293b', color:'#e5e7eb', borderRadius:999, padding:'10px 14px', outline:'none' }}
          />
          <button className="ai-btn" onClick={send} disabled={!input.trim() || loading}>Send</button>
        </div>
        <div style={{ fontSize:12, color:'#9ca3af' }}>
          Сообщения сохраняются локально • Черновик спеки хранится в памяти • Применение (Upload→Generate→Deploy) добавим позже
        </div>
      </div>
    </div>
  )
}


