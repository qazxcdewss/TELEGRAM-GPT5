import { useEffect, useMemo, useRef, useState } from 'react'
import { AppRoot } from '@telegram-apps/telegram-ui'
import AiChatPane from './components/AiChatPane'
import './index.css'
import { API_BASE, getActiveBotId, setActiveBotId as setActiveBotIdGlobal } from './lib/api'
import { loadState } from './lib/storage'

const BOT_ID0  = (window as any).BOT_ID || (import.meta as any).env?.VITE_BOT_ID || 'my-bot-1'

type Msg = { id: string; who: 'user'|'bot'|'sys'; text: string; ts: number; buttons?: Array<Array<{ text: string; data?: string }>> }
const uid = () => Math.random().toString(36).slice(2)
const fmtDateChip = (ts: number) => new Date(ts).toLocaleDateString(undefined, { day: '2-digit', month: 'long' })

export default function App() {
  const [emuCollapsed, setEmuCollapsed] = useState(false)
  const [activeBotId, setActiveBotId] = useState<string>(() => localStorage.getItem('activeBotId') || BOT_ID0)
  const [input, setInput] = useState('/start')
  const [msgs, setMsgs] = useState<Msg[]>([
    { id: uid(), who: 'sys', text: 'Эмулятор готов. Напишите сообщение и нажмите Send.', ts: Date.now() }
  ])

  // --- эмуляция для /emu/wh ---
  type EmuMode = 'auto'|'spec'|'active'|'rev'
  type Engine = 'local'|'gpt5'
  const [engine, setEngine] = useState<Engine>('local')
  const [mode, setMode] = useState<EmuMode>('auto')
  const [revHash, setRevHash] = useState('')

  // --- меню команд (опц.) ---
  type BotCommand = { command: string; description?: string }
  const [menuOpen, setMenuOpen] = useState(false)
  const [commands, setCommands] = useState<BotCommand[] | null>(null)
  const [loadingCmds, setLoadingCmds] = useState(false)

  useEffect(() => { localStorage.setItem('activeBotId', activeBotId) }, [activeBotId])

  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), [msgs.length])
  function push(m: Msg) { setMsgs(xs => [...xs, m]) }

  async function tryFetchJson(url: string) {
    try { const r = await fetch(url); return r.ok ? await r.json() : null } catch { return null }
  }
  async function loadCommandsLazy() {
    if (commands || loadingCmds) return
    setLoadingCmds(true)
    let data = await tryFetchJson(`${API_BASE}/api/bots/${encodeURIComponent(activeBotId)}/commands`)
    if (!data) data = await tryFetchJson(`${API_BASE}/commands?botId=${encodeURIComponent(activeBotId)}`)
    if (!data) {
      const specLast = await tryFetchJson(`${API_BASE}/spec/latest?botId=${encodeURIComponent(activeBotId)}`)
      const fromSpec = (specLast as any)?.commands || (specLast as any)?.meta?.commands
      if (Array.isArray(fromSpec)) data = fromSpec
    }
    if (Array.isArray(data)) setCommands(data as BotCommand[])
    else setCommands([{ command:'start' }, { command:'help' }, { command:'menu' }])
    setLoadingCmds(false)
  }
  function openMenu()  { setMenuOpen(true);  void loadCommandsLazy() }
  function closeMenu() { setMenuOpen(false) }
  function applyCommand(cmd: string) { const s = cmd.startsWith('/') ? cmd : `/${cmd}`; setInput(s); setMenuOpen(false) }

  async function send(text: string) {
    const trimmed = text.trim()
    if (!trimmed) return
    push({ id: uid(), who: 'user', text: trimmed, ts: Date.now() })
    await sendToEmu(trimmed)
  }

  async function sendToEmu(text: string) {
    const botId = getActiveBotId()
    const update = { update_id: Date.now(), message: { chat: { id: 12345, type: 'private' }, text } }
    const { draft } = loadState() || {}
    const effMode: EmuMode = mode === 'auto' ? (draft ? 'spec' : 'active') : mode
    const body: any = { botId, engine, update }
    if (effMode === 'spec') {
      if (!draft) { push({ id: uid(), who:'sys', text:'Нет draft спеки — переключаюсь на Active', ts: Date.now() }); body.mode = 'active' }
      else { body.mode = 'spec'; body.spec = draft }
    } else if (effMode === 'rev') {
      if (!revHash) { push({ id: uid(), who:'sys', text:'Укажи revHash', ts: Date.now() }); return }
      body.mode = 'rev'; body.revHash = revHash
    } else { body.mode = 'active' }

    try {
      const res = await fetch(`${API_BASE}/emu/wh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-bot-id': botId },
        body: JSON.stringify(body)
      })
      const j = await res.json().catch(()=>null)
      if (!j?.ok) { push({ id: uid(), who:'sys', text: 'Эмуляция не удалась: ' + (j?.error || `HTTP_${res.status}`), ts: Date.now() }); return }
      for (const m of (j.messages || [])) {
        const raw = (m && typeof m === 'object' && 'text' in m) ? (m as any).text : m
        const txt =
          typeof raw === 'string' ? raw :
          raw == null ? '' :
          typeof raw === 'object' ? JSON.stringify(raw, null, 2) :
          String(raw)
        push({ id: uid(), who:'bot', text: txt, ts: Date.now() })
      }
    } catch (e:any) {
      push({ id: uid(), who:'sys', text:'Network error: ' + (e?.message||e), ts: Date.now() })
    }
  }

  function onButtonClick(b: { text: string; data?: string }) {
    const out = b?.data || b?.text
    setInput(out)
    void send(out)
  }

  const withDateChips = useMemo(() => {
    const out: Array<Msg | { chip: string; key: string }> = []
    let last = ''
    for (const m of msgs) {
      const chip = fmtDateChip(m.ts)
      if (chip !== last) { last = chip; out.push({ chip, key: 'chip-'+m.id }) }
      out.push(m)
    }
    return out
  }, [msgs])

  return (
    <AppRoot appearance="light">
      <div className="layout">
        {/* ===== LEFT: Spec Assistant ===== */}
        <aside className="left-pane">
          <AiChatPane botId={activeBotId} />
        </aside>

        {/* ===== RIGHT: Emulator ===== */}
        <section className={`right-pane ${emuCollapsed ? 'is-collapsed' : ''}`}>
          <header className="emu-header">
            <div className="emu-title">Bot Emulator</div>
            <div className="emu-tools">
              <span className="tg-sub">Emu:</span>
              <select value={mode} onChange={e=>setMode(e.target.value as EmuMode)} style={{ padding:'6px 8px', borderRadius:8 }}>
                <option value="auto">Auto (Draft→Active)</option>
                <option value="spec">Draft (by spec → bot.js)</option>
                <option value="active">Active (current)</option>
                <option value="rev">Rev (revHash)</option>
              </select>
              <span className="tg-sub">Engine:</span>
              <select value={engine} onChange={e=>setEngine(e.target.value as Engine)} style={{ padding:'6px 8px', borderRadius:8 }}>
                <option value="local">local</option>
                <option value="gpt5">gpt5</option>
              </select>
              {mode==='rev' && (
                <input value={revHash} onChange={e=>setRevHash(e.target.value)} placeholder="revHash" style={{minWidth:260}} />
              )}
              <span className="tg-sub">bot id</span>
              <input
                value={activeBotId}
                onChange={e=>{ setActiveBotId(e.target.value); setActiveBotIdGlobal(e.target.value) }}
                style={{ padding:'6px 8px', minWidth:200, borderRadius:8,
                         border:'1px solid rgba(255,255,255,.08)',
                         background:'#0f1b26', color:'#e6e6e6' }}
              />
            </div>
            <button className="emu-toggle" onClick={()=>setEmuCollapsed(v=>!v)} aria-expanded={!emuCollapsed}>
              {emuCollapsed ? 'Развернуть чат' : 'Свернуть чат'}
            </button>
          </header>
          <div className="emu-body">
            <div className="emu-feed">
              <div className="emu-feed__spacer" />
              {withDateChips.map(item =>
                'chip' in item ? (
                  <div key={item.key} className="tg-date"><span>{item.chip}</span></div>
                ) : (
                  <div key={item.id} className={`tg-row ${item.who==='user' ? 'right' : ''}`}>
                    <div className={`tg-bubble ${item.who==='user' ? 'tg-outgoing' : 'tg-incoming'}`}>
                      <span style={{ whiteSpace: 'pre-wrap' }}>{item.text}</span>
                      <span className="tg-metaRow">
                        <span className="tg-time">
                          {new Date(item.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                        {item.who === 'user' && (
                          <span className="tg-checks double">
                            <svg viewBox="0 0 24 24"><path d="M0 12l2-2 6 6L22 2l2 2L8 20z"/></svg>
                            <svg viewBox="0 0 24 24"><path d="M0 12l2-2 6 6L22 2l2 2L8 20z"/></svg>
                          </span>
                        )}
                      </span>
                      {item.buttons?.length ? (
                        <div className="tg-ik">
                          {item.buttons.map((row, ri) => (
                            <div className="tg-ik-row" key={ri}>
                              {row.map((b, bi) => (
                                <button key={bi} onClick={()=>onButtonClick(b)}>{b.text}</button>
                              ))}
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>
                )
              )}
              <div ref={endRef} id="emu-bottom-sentinel" />
            </div>
            <div className="emu-input">
              <div className="tg-input" style={{ position: 'relative' }}>
                <div className="tg-menu-button" onClick={menuOpen ? closeMenu : openMenu}>Меню</div>
                <input
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      input.trim() && (send(input), setInput(''))
                    }
                  }}
                  placeholder="Сообщение…"
                  style={{ marginLeft: 8 }}
                />
                <button className="tg-send" onClick={() => { if (input.trim()) { send(input); setInput('') } }}>
                  <svg viewBox="0 0 24 24"><path d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg>
                </button>
                {menuOpen && (
                  <div className="tg-menu-popup">
                    <div className="tg-menu-head">
                      <div>Команды бота</div>
                      <button onClick={closeMenu} style={{ padding: '6px 10px', borderRadius: 8 }}>Закрыть</button>
                    </div>
                    <div className="tg-menu-list">
                      {loadingCmds && <div style={{ padding: 10, color: '#8a98a6' }}>Загрузка…</div>}
                      {!loadingCmds && (!commands || commands.length === 0) && (
                        <div style={{ padding: 10, color: '#8a98a6' }}>Команд не найдено</div>
                      )}
                      {!loadingCmds && commands?.map((c, i) => (
                        <div key={i} className="tg-menu-item" onClick={()=>applyCommand(c.command)}>
                          <div className="tg-menu-cmd">/{c.command.replace(/^\//,'')}</div>
                          <div className="tg-menu-desc">{c.description || ''}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>
      </div>
    </AppRoot>
  )
}
