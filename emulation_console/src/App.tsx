import { useEffect, useMemo, useRef, useState } from 'react'
import { AppRoot } from '@telegram-apps/telegram-ui'
import AiChatPane from './components/AiChatPane'

const API      = (window as any).API       || (import.meta as any).env?.VITE_API       || 'http://localhost:3000'
const BOT_ID0  = (window as any).BOT_ID    || (import.meta as any).env?.VITE_BOT_ID    || 'my-bot-1'
const SECRET   = (window as any).BOT_SECRET|| (import.meta as any).env?.VITE_BOT_SECRET|| 'dev'

type Msg = { id: string; who: 'user'|'bot'|'sys'; text: string; ts: number; buttons?: Array<Array<{ text: string; data?: string }>> }
const uid = () => Math.random().toString(36).slice(2)
const fmtDateChip = (ts: number) => new Date(ts).toLocaleDateString(undefined, { day: '2-digit', month: 'long' })

export default function App() {
  const [assistantDraft, setAssistantDraft] = useState('Опишите изменения…')
  const [activeBotId, setActiveBotId] = useState<string>(() => localStorage.getItem('activeBotId') || BOT_ID0)
  const [botTitle] = useState('Bot Emulator')
  const [input, setInput] = useState('/start')
  const [msgs, setMsgs] = useState<Msg[]>([
    { id: uid(), who: 'sys', text: 'Эмулятор готов. Напишите сообщение и нажмите Send.', ts: Date.now() }
  ])

  // --- Меню команд ---
  type BotCommand = { command: string; description?: string }
  const [menuOpen, setMenuOpen] = useState(false)
  const [commands, setCommands] = useState<BotCommand[] | null>(null)
  const [loadingCmds, setLoadingCmds] = useState(false)

  const tryFetchJson = async (url: string) => {
    try {
      const r = await fetch(url)
      if (!r.ok) return null
      return await r.json()
    } catch { return null }
  }

  async function loadCommandsLazy() {
    if (commands || loadingCmds) return
    setLoadingCmds(true)

    let data = await tryFetchJson(`${API}/api/bots/${encodeURIComponent(activeBotId)}/commands`)
    if (!data) data = await tryFetchJson(`${API}/commands?botId=${encodeURIComponent(activeBotId)}`)
    if (!data) {
      const specLast = await tryFetchJson(`${API}/spec/latest?botId=${encodeURIComponent(activeBotId)}`)
      const fromSpec = (specLast as any)?.commands || (specLast as any)?.meta?.commands
      if (Array.isArray(fromSpec)) data = fromSpec
    }

    if (Array.isArray(data)) setCommands(data as BotCommand[])
    else setCommands([
      { command: 'start', description: 'Start the bot' },
      { command: 'help',  description: 'Get help' },
      { command: 'menu',  description: 'Open main menu' },
    ])
    setLoadingCmds(false)
  }

  function openMenu()  { setMenuOpen(true);  void loadCommandsLazy() }
  function closeMenu() { setMenuOpen(false) }
  function applyCommand(cmd: string) {
    const withSlash = cmd.startsWith('/') ? cmd : `/${cmd}`
    setInput(withSlash)
    setMenuOpen(false)
  }

  useEffect(() => { localStorage.setItem('activeBotId', activeBotId) }, [activeBotId])

  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), [msgs.length])
  function push(m: Msg) { setMsgs(xs => [...xs, m]) }

  function parseBotReply(raw: string): Omit<Msg,'id'|'ts'|'who'> {
    try {
      const j = JSON.parse(raw)
      const text: string = j?.text ?? j?.message ?? j?.result?.text ?? String(raw)
      const buttons = j?.reply_markup?.inline_keyboard || j?.inline_keyboard || undefined
      return { text: String(text), buttons }
    } catch { return { text: raw } }
  }

  async function send(text: string) {
    const trimmed = text.trim()
    if (!trimmed) return
    push({ id: uid(), who: 'user', text: trimmed, ts: Date.now() })

    const update = { update_id: Math.floor(Math.random()*1e9), message: { chat: { id: 12345, type: 'private' }, text: trimmed } }
    try {
      const r = await fetch(`${API}/wh/${encodeURIComponent(activeBotId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-bot-secret': SECRET },
        body: JSON.stringify(update),
      })
      const t = await r.text()
      const parsed = parseBotReply(t)
      push({ id: uid(), who: 'bot', ts: Date.now(), ...parsed })
    } catch (e:any) {
      push({ id: uid(), who: 'sys', text: 'Ошибка /wh: ' + (e?.message || e), ts: Date.now() })
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
    <AppRoot appearance="light">{/* поменяй на "dark", если хочешь тёмную */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(380px, 480px) 1fr', height: '100vh' }}>
        {/* LEFT: AI Chat Pane */}
        <AiChatPane />

        {/* ===== RIGHT: Telegram-like window ===== */}
        <div className="tg-window">
          <div className="tg-chat-frame">
            {/* Header */}
            <div className="tg-header">
              <div className="tg-avatar" />
              <div style={{lineHeight: 1.2}}>
                <div className="tg-title">Bot Emulator</div>
                <div className="tg-sub">bot • {activeBotId}</div>
              </div>
              <div style={{marginLeft: 'auto', display:'flex', gap:8, alignItems:'center'}}>
                <span className="tg-sub">bot id</span>
                <input value={activeBotId} onChange={e=>setActiveBotId(e.target.value)}
                       style={{padding:'6px 8px', minWidth:200, borderRadius:8,
                               border:'1px solid rgba(255,255,255,.08)',
                               background:'#0f1b26', color:'#e6e6e6'}} />
              </div>
            </div>

            {/* Messages */}
            <div className="tg-scroll">
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

                      {/* inline-кнопки, если есть */}
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
              <div ref={endRef} />
            </div>

            {/* Input bar + Menu */}
            <div className="tg-input" style={{ position: 'relative' }}>
              {/* Menu button */}
              <div className="tg-menu-button" onClick={menuOpen ? closeMenu : openMenu}>
                Меню
              </div>

              {/* Input */}
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

              {/* Send button with arrow */}
              <button className="tg-send" onClick={() => { if (input.trim()) { send(input); setInput('') } }}>
                <svg viewBox="0 0 24 24">
                  <path d="M2 21l21-9L2 3v7l15 2-15 2z"/>
                </svg>
              </button>

              {/* Popup меню команд как было */}
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
      </div>
    </AppRoot>
  )
}
