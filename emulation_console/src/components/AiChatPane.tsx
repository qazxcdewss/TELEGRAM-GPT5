import { useEffect, useRef, useState } from 'react'
import { nlChat, nlSpec } from '../lib/api'
import { applyPatch, type Op } from '../lib/patch'
import { loadState, saveState, resetState } from '../lib/storage'
// old UI components no longer used in new layout

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
    <div className="ai-root">
      {/* header */}
      <div className="ai-header">
        <div className="ai-title">Spec Assistant</div>
        <div className="ai-meta">{draft ? 'Draft: in memory (не применён)' : 'Draft: empty'}</div>
        <div className="ai-tools">
          <label style={{ fontSize:12, color:'var(--ai-dim)' }}>
            Mode:&nbsp;
            <select value={mode} onChange={e=>setMode(e.target.value as any)}
                    style={{ background:'transparent', color:'var(--ai-text)', border:'1px solid var(--ai-border)', borderRadius:8, padding:'4px 8px' }}>
              <option value="patch">Patch</option>
              <option value="full">Full</option>
            </select>
          </label>
          <button className="ai-btn" onClick={clearAll}>Reset</button>
        </div>
      </div>

      {/* feed */}
      <div className="ai-feed" ref={scrollRef}>
        <div className="ai-feed__spacer" />
        {messages.map(m => (
          <div key={m.id} className={`ai-row ${m.role==='user' ? 'ai-row--user' : ''}`}>
            <div className={`ai-bubble ${m.role==='user' ? 'ai-bubble--user' : ''}`}>
              {m.text}
            </div>
          </div>
        ))}

        {messages.map(m => (
          m.attachments?.map((a, i) => (
            <div key={m.id + ':' + i} className="ai-row">
              <div className="ai-bubble" style={{ width:'100%' }}>
                <div style={{ fontWeight:600, marginBottom:8 }}>
                  {a.kind === 'patch' ? 'Patch (RFC6902)' : a.kind === 'full-spec' ? 'Сгенерированная спека' : 'Черновик (422)'}
                </div>
                <pre className="ai-json">{JSON.stringify(a.data, null, 2)}</pre>
                <div style={{ display:'flex', gap:8, marginTop:8 }}>
                  {a.kind === 'patch' && <button className="ai-btn" onClick={()=>applyPatchLocally(a.data as Op[])}>Apply patch locally</button>}
                  {a.kind !== 'patch' && <button className="ai-btn" onClick={()=>useAsDraft(a.data)}>Use as draft</button>}
                </div>
              </div>
            </div>
          ))
        ))}
      </div>

      {/* input */}
      <div className="ai-input">
        <div className="ai-input__row">
          <input
            className="ai-textbox"
            placeholder="Опиши идею бота, команды, сценарии…"
            value={input}
            onChange={e=>setInput(e.target.value)}
            onKeyDown={e=>{ if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
          />
          <button className="ai-btn" onClick={send} disabled={!input.trim() || loading}>Send</button>
        </div>
        <div className="ai-hint">
          Сообщения сохраняются локально • Черновик спеки хранится в памяти • Применение (Upload→Generate→Deploy) добавим позже
        </div>
      </div>
    </div>
  )
}


