import { useEffect, useRef, useState } from 'react'

const API = import.meta.env.VITE_API_BASE as string
const BOT_ID = import.meta.env.VITE_BOT_ID as string
const BOT_SECRET = import.meta.env.VITE_BOT_SECRET as string

type Revision = { revHash: string; createdAt: string }

export default function App() {
  const [spec, setSpec] = useState<string>(
    `{
  "meta": { "botId": "${BOT_ID}" }
}`
  )
  const [revs, setRevs] = useState<Revision[]>([])
  const [activeRev, setActiveRev] = useState<string | null>(null)
  const [selectedRev, setSelectedRev] = useState<string | null>(null)
  const [log, setLog] = useState<string[]>([])
  const esRef = useRef<EventSource | null>(null)
  const [engine, setEngine] = useState<'local'|'gpt5'>('local')
  const [testText, setTestText] = useState<string>('/start')
  const [nlText, setNlText] = useState<string>('Опиши, какого бота вы хотите.')
  const [nlLastPatch, setNlLastPatch] = useState<string>('')
  const [nlMode, setNlMode] = useState<'patch'|'full'>('patch')
  const [prefs, setPrefs] = useState({ brand:'Brand', locale:'ru', tone:'neutral', baseApi:'https://api.example.com' })
  const [nlLoading, setNlLoading] = useState<boolean>(false)
  const [nlChat, setNlChat] = useState<Array<{role:'user'|'assistant', text:string, ts:number}>>([])
  const [chatInput, setChatInput] = useState<string>('Привет! Хочу бота для заказа пиццы, начнём со /start и меню sizes.')

  // Активный бот и список ботов
  const [bots, setBots] = useState<Array<{ botId: string; title?: string }>>([])
  const [activeBotId, setActiveBotId] = useState<string>(() => localStorage.getItem('activeBotId') || (BOT_ID || 'my-bot-1'))

  const API_BASE = (window as any).API || (import.meta as any).env?.VITE_API || API

  // Единый helper с x-bot-id и JSON по умолчанию
  async function apiFetch(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers || {})
    if (activeBotId) headers.set('x-bot-id', activeBotId)
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
    const res = await fetch(`${API_BASE}${path}`, { ...init, headers })
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      throw new Error(t || `HTTP_${res.status}`)
    }
    return res
  }

  // Add Bot form
  const [newBotId, setNewBotId] = useState('my-bot-1')
  const [newBotTitle, setNewBotTitle] = useState('My Bot')
  const [newBotToken, setNewBotToken] = useState('')
  const [autoWebhook, setAutoWebhook] = useState(true)

  async function addBotAndMaybeWebhook() {
    try {
      if (!newBotId || !newBotToken) { alert('botId и BotFather token обязательны'); return }
      // 1) Create bot
      const create = await apiFetch('/api/bots', {
        method: 'POST',
        body: JSON.stringify({ botId: newBotId, title: newBotTitle || newBotId, token: newBotToken })
      }).then(r => r.json())
      append('[bots] created ' + (create?.botId || newBotId))
      setActiveBotId(newBotId)
      // 2) Auto set webhook (URL сервер вычислит сам)
      if (autoWebhook) {
        const setWh = await apiFetch(`/api/bots/${encodeURIComponent(newBotId)}/setWebhook`, {
          method: 'POST',
          body: JSON.stringify({})
        }).then(r => r.json().catch(()=>({})))
        append('[bots] webhook set ' + JSON.stringify(setWh).slice(0,120))
      }
      // 3) refresh bots list
      try {
        const r2 = await apiFetch('/api/bots', { method:'GET' })
        const list = await r2.json()
        if (Array.isArray(list)) setBots(list.map((b:any)=>({ botId: String(b.bot_id || b.botId || b.id), title: b.title })))
      } catch {}
    } catch (e:any) {
      append('[bots] add error ' + (e?.message || e)); alert(e?.message || e)
    }
  }

  // Ревизии выбранного бота
  const [revisions, setRevisions] = useState<Array<{revHash:string; createdAt?:string}>>([])
  const [loadingRevs, setLoadingRevs] = useState(false)

  async function loadRevisions() {
    try {
      setLoadingRevs(true)
      const r = await apiFetch(`/revisions?botId=${encodeURIComponent(activeBotId)}`, { method:'GET' })
      const j = await r.json().catch(()=>null as any)
      const arr = Array.isArray(j) ? j : Array.isArray(j?.items) ? j.items : []
      const list = arr.map((x:any)=>({
        revHash: String(x.revHash || x.rev_hash || x.rev || ''),
        createdAt: x.createdAt || x.created_at
      }))
      setRevisions(list)
    } finally { setLoadingRevs(false) }
  }

  useEffect(() => { loadRevisions().catch(()=>{}) }, [activeBotId])

  // Фильтр SSE
  const [sseFilter, setSseFilter] = useState<{gen:boolean; dep:boolean; wh:boolean; other:boolean}>({ gen:true, dep:true, wh:true, other:true })

  const append = (line: string) =>
    setLog((l) => [new Date().toLocaleTimeString() + ' ' + line, ...l].slice(0, 200))

  async function nlPropose() {
    try {
      setNlLoading(true)
      const API_BASE = (window as any).API || (import.meta as any).env?.VITE_API || API
      let currentSpec: any = null
      const specTrim = (spec || '').trim()
      if (specTrim) {
        try { currentSpec = JSON.parse(specTrim) } catch { alert('Spec (справа) не валиден JSON'); return }
      }
      const r = await fetch(`${API_BASE}/api/nl/spec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: nlText, currentSpec }),
      })
      const txt = await r.text()
      let j: any = null
      try { j = JSON.parse(txt) } catch {}
      if (!r.ok) {
        if (r.status === 422 && j?.draft) {
          append('[nl] spec invalid: ' + JSON.stringify(j?.error?.details || [], null, 2))
          setNlLastPatch(JSON.stringify(j.draft, null, 2))
          setSpec(JSON.stringify(j.draft, null, 2))
          return
        }
        append('[nl] error ' + (txt || 'HTTP_'+r.status)); alert(txt); return
      }
      if (!j) { append('[nl] error: bad JSON'); alert('Bad JSON'); return }
      setNlLastPatch(JSON.stringify(j.patch ?? j.targetSpec, null, 2))
      if (j?.targetSpec) setSpec(JSON.stringify(j.targetSpec, null, 2))
      append('[nl] ok')
    } catch (e:any) {
      append('[nl] exception ' + (e?.message || e))
    } finally {
      setNlLoading(false)
    }
  }

  async function sendChat() {
    try {
      setNlLoading(true)
      const API_BASE = (window as any).API || (import.meta as any).env?.VITE_API || API
      let currentSpec: any = null
      const specTrim = (spec || '').trim()
      if (specTrim) { try { currentSpec = JSON.parse(specTrim) } catch { alert('Spec JSON invalid'); return } }

      const history = nlChat.map(m => ({ role: m.role, text: m.text }))
      const r = await fetch(`${API_BASE}/api/nl/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [...history, { role:'user', text: chatInput }], currentSpec, mode: nlMode }),
      })
      const txt = await r.text()
      let j:any = null; try { j = JSON.parse(txt) } catch {}
      setNlChat(ch => [...ch, { role:'user', text: chatInput, ts: Date.now() }])
      setChatInput('')

      if (!r.ok) {
        if (r.status === 422 && j?.draft) {
          setSpec(JSON.stringify(j.draft, null, 2))
          setNlChat(ch => [...ch, { role:'assistant', text: 'Я подготовил черновик спеки, но AJV нашёл несоответствия. Проверьте редактор справа, скорректируйте и нажмите Upload.', ts: Date.now() }])
          return
        }
        setNlChat(ch => [...ch, { role:'assistant', text: `Ошибка: ${(j?.error?.code || 'HTTP_'+r.status)}`, ts: Date.now() }])
        return
      }

      const assistant = j?.assistant || 'Готово.'
      setNlChat(ch => [...ch, { role:'assistant', text: assistant, ts: Date.now() }])
      if (j?.targetSpec) setSpec(JSON.stringify(j.targetSpec, null, 2))
      if (j?.patch) setNlLastPatch(JSON.stringify(j.patch, null, 2))
    } catch (e:any) {
      setNlChat(ch => [...ch, { role:'assistant', text: 'Произошла ошибка на стороне клиента.', ts: Date.now() }])
    } finally {
      setNlLoading(false)
    }
  }

  function applyNlPatchLocally() {
    try {
      const ops = JSON.parse(nlLastPatch)
      if (!Array.isArray(ops)) { alert('В буфере не Patch, а полный объект — он уже применён.'); return }
      const body = JSON.parse(spec || '{}')
      const apply = (doc:any, op:any) => {
        const segs = String(op.path || '').split('/').slice(1).map(s=>s.replace(/~1/g,'/').replace(/~0/g,'~'))
        const parentPath = segs.slice(0, -1)
        const key = segs[segs.length-1]
        let cur = doc; for (const s of parentPath) cur = cur[s]
        if (op.op === 'add' || op.op === 'replace') { (cur as any)[key] = op.value }
        else if (op.op === 'remove') { if (Array.isArray(cur)) (cur as any).splice(Number(key),1); else delete (cur as any)[key] }
      }
      const next = JSON.parse(JSON.stringify(body))
      for (const op of ops) apply(next, op)
      setSpec(JSON.stringify(next, null, 2))
      append('[nl] patch applied locally')
    } catch (e:any) {
      alert('Не удалось применить Patch: ' + (e?.message || e))
    }
  }

  async function refresh() {
    const r1 = await apiFetch(`/revisions?botId=${encodeURIComponent(activeBotId)}`).then((r) => r.json())
    setRevs(
      (r1?.items ?? []).map((x: any) => ({
        revHash: x.rev_hash || x.revHash,
        createdAt: x.created_at || x.createdAt,
      }))
    )
    const r2 = await apiFetch(`/bots/${encodeURIComponent(activeBotId)}`).then((r) => r.json())
    setActiveRev(r2?.activeRevHash ?? null)
  }

  // Подключение SSE с фильтрами
  useEffect(() => {
    try { esRef.current?.close() } catch {}
    const url = `${API}/events`
    const es = new EventSource(url, { withCredentials: true } as any)
    esRef.current = es
    es.onopen = () => append('[sse] open')
    es.onerror = () => append('[sse] error')
    es.onmessage = (e) => {
      const line = String((e as MessageEvent).data || '')
      if (!line) return
      const lower = line.toLowerCase()
      let type: 'gen'|'dep'|'wh'|'other' = 'other'
      if (lower.includes('generate')) type = 'gen'
      else if (lower.includes('deploy')) type = 'dep'
      else if (lower.includes('/wh/') || lower.includes('webhook')) type = 'wh'
      if (!sseFilter.gen && type==='gen') return
      if (!sseFilter.dep && type==='dep') return
      if (!sseFilter.wh  && type==='wh')  return
      if (!sseFilter.other && type==='other') return
      if (activeBotId && !line.includes(activeBotId)) {
        // можно включить строгую фильтрацию по botId, если сервер пишёт его в событие
        // return
      }
      append('[sse] ' + line.slice(0, 500))
    }
    return () => { try { es.close() } catch {} }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBotId, sseFilter.gen, sseFilter.dep, sseFilter.wh, sseFilter.other])

  // Подтянуть список ботов при старте
  useEffect(() => {
    ;(async () => {
      try {
        const r = await apiFetch('/api/bots', { method: 'GET' })
        const j = await r.json().catch(() => null as any)
        const arr = Array.isArray(j) ? j : Array.isArray(j?.bots) ? j.bots : []
        setBots(arr.map((b:any)=>({ botId: String(b.bot_id || b.botId || b.id), title: b.title })))
      } catch {}
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Сохранять выбор активного бота
  useEffect(() => {
    if (activeBotId) localStorage.setItem('activeBotId', activeBotId)
  }, [activeBotId])

  async function uploadSpec() {
    try {
      const body = JSON.parse(spec)
      await apiFetch('/spec', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      append('Spec uploaded')
      refresh()
    } catch (e: any) {
      append('Spec ERROR: ' + e.message)
    }
  }

  async function generate() {
    try {
      append('[ui] generate clicked')

      let specVersionId: number | undefined
      const specTrim = (spec || '').trim()
      if (specTrim) {
        let parsed: any
        try {
          parsed = JSON.parse(specTrim)
        } catch (e) {
          append('[ui] spec is not valid JSON')
          alert('Spec is not valid JSON')
          return
        }
        const r = await apiFetch('/spec', {
          method: 'POST',
          body: JSON.stringify(parsed)
        })
        if (!r.ok) {
          const t = await r.text()
          append('[spec] error ' + t)
          alert('POST /spec failed: ' + t)
          return
        }
        const j = await r.json()
        specVersionId = j?.specVersionId ?? j?.version
        append(`[spec] created specVersionId=${specVersionId}`)
      }

      const body: any = { engine, botId: activeBotId }
      if (specVersionId) body.specVersion = specVersionId

      const r2 = await apiFetch('/generate', {
        method: 'POST',
        body: JSON.stringify(body)
      })
      if (!r2.ok) {
        const t = await r2.text()
        append('[gen] error ' + t)
        alert('POST /generate failed: ' + t)
        return
      }
      const j2 = await r2.json().catch(() => null)
      if (j2?.taskId) {
        append(`Generate started task=${j2.taskId} v=${specVersionId ?? ''}`)
      } else {
        const txt = typeof j2 === 'string' ? j2 : JSON.stringify(j2)
        append('[gen] ok ' + (txt || '').slice(0, 300))
      }

      try { await refresh?.() } catch {}
    } catch (e: any) {
      console.error(e)
      append('[gen] exception ' + (e?.message || e))
      alert('Generate exception: ' + (e?.message || String(e)))
    }
  }

  async function uploadGenDeploy() {
    try {
      append('[ui] upload→generate→deploy')

      // 1) parse spec
      let parsed: any
      try { parsed = JSON.parse((spec || '').trim()) } catch { alert('Spec JSON invalid'); return }

      // 2) /spec
      const r1 = await apiFetch('/spec', { method:'POST', body: JSON.stringify(parsed) })
      if (!r1.ok) { const t = await r1.text(); append('[spec] error '+t); alert(t); return }
      const j1 = await r1.json(); const specVersionId = j1.specVersionId ?? j1.version; append(`[spec] ok v=${specVersionId}`)

      // 3) /generate
      const r2 = await apiFetch('/generate', { method:'POST', body: JSON.stringify({ engine, specVersionId, botId: activeBotId }) })
      if (!r2.ok) { const t = await r2.text(); append('[gen] error '+t); alert(t); return }
      const j2 = await r2.json().catch(async()=>({ revHash: (await r2.text()) }))
      const revHash = (j2 as any).revHash || (j2 as any).rev_hash
      append(`[gen] ok rev=${revHash}`)

      // 4) /deploy
      const botId = String(parsed?.meta?.botId ?? activeBotId)
      const r3 = await apiFetch('/deploy', { method:'POST', body: JSON.stringify({ botId, revHash }) })
      if (!r3.ok) { const t = await r3.text(); append('[dep] error '+t); alert(t); return }
      append('[dep] ok')
    } catch (e:any) {
      append('[ui] oops '+(e?.message||e))
    }
  }

  async function deploy() {
    if (!selectedRev) { append('Select a revision'); return }
    const r = await apiFetch('/deploy', {
      method: 'POST',
      body: JSON.stringify({ botId: activeBotId, revHash: selectedRev }),
    })
    if (!r.ok) { append('Deploy ERROR: ' + (await r.text())); return }
    const { taskId } = await r.json()
    append(`Deploy started task=${taskId} rev=${selectedRev}`)
  }

  async function testWebhook() {
    const API = (window as any).API || (import.meta as any).env?.VITE_API || 'http://localhost:3000'
    const BOT_ID = (window as any).BOT_ID || (import.meta as any).env?.VITE_BOT_ID || 'my-bot-1'
    const BOT_SECRET = (window as any).BOT_SECRET || (import.meta as any).env?.VITE_BOT_SECRET || 'dev'

    const sampleUpdate = {
      update_id: Math.floor(Math.random() * 1e9),
      message: { chat: { id: 12345, type: 'private' }, text: testText || '/start' }
    }
    const r = await fetch(`${API}/wh/${encodeURIComponent(BOT_ID)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-bot-secret': BOT_SECRET },
      body: JSON.stringify(sampleUpdate),
    })
    const t = await r.text()
    append(`[wh] echo: ${t.slice(0, 200)}`)
  }

  async function fetchMetrics() {
    const r = await apiFetch('/metrics').then(r=>r.json())
    append('[metrics] ' + JSON.stringify(r))
  }
  async function fetchDLQ() {
    const r = await apiFetch(`/dlq/${encodeURIComponent(activeBotId)}`).then(r=>r.json())
    append('[dlq] ' + JSON.stringify(r))
  }

  return (
    <div style={{ fontFamily: 'ui-sans-serif, system-ui', padding: 20 }}>
      <style>{`@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}} .spinner{width:16px;height:16px;border:2px solid #cbd5e1;border-top-color:#111827;border-radius:50%;animation:spin .8s linear infinite;display:inline-block}`}</style>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 12 }}>Bot Console (MVP)</h1>

      {/* SSE filter */}
      <div style={{ display:'flex', gap:12, alignItems:'center', margin:'0 0 16px' }}>
        <b style={{fontSize:13}}>Log filter:</b>
        <label style={{fontSize:13}}><input type="checkbox" checked={sseFilter.gen} onChange={e=>setSseFilter(v=>({...v, gen:e.target.checked}))}/> Generate</label>
        <label style={{fontSize:13}}><input type="checkbox" checked={sseFilter.dep} onChange={e=>setSseFilter(v=>({...v, dep:e.target.checked}))}/> Deploy</label>
        <label style={{fontSize:13}}><input type="checkbox" checked={sseFilter.wh}  onChange={e=>setSseFilter(v=>({...v, wh:e.target.checked}))}/> Webhook</label>
        <label style={{fontSize:13}}><input type="checkbox" checked={sseFilter.other} onChange={e=>setSseFilter(v=>({...v, other:e.target.checked}))}/> Other</label>
      </div>

      {/* Add Bot (server-side auto webhook) */}
      <section style={{ border: '1px solid #eee', borderRadius: 12, padding: 12, marginBottom: 16 }}>
        <h2 style={{ marginTop: 0 }}>Add Bot</h2>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <label style={{ fontSize: 13 }}>Bot ID
            <input value={newBotId} onChange={e=>setNewBotId(e.target.value)} style={{ width:'100%', padding:'6px 8px' }} />
          </label>
          <label style={{ fontSize: 13 }}>Title
            <input value={newBotTitle} onChange={e=>setNewBotTitle(e.target.value)} style={{ width:'100%', padding:'6px 8px' }} />
          </label>
          <label style={{ fontSize: 13 }}>BotFather Token
            <input value={newBotToken} onChange={e=>setNewBotToken(e.target.value)} style={{ width:'100%', padding:'6px 8px' }} placeholder="123456:AA..." />
          </label>
          <label style={{ display:'flex', alignItems:'center', gap:8, fontSize: 13 }}>
            <input type="checkbox" checked={autoWebhook} onChange={e=>setAutoWebhook(e.target.checked)} />
            Auto set webhook via ngrok
          </label>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button onClick={addBotAndMaybeWebhook}>Create</button>
        </div>
      </section>

      {/* ——— Active Bot ——— */}
      <div style={{ display:'flex', gap:12, alignItems:'center', margin:'4px 0 16px' }}>
        <label style={{ fontSize:13 }}>
          Active Bot:&nbsp;
          <select value={activeBotId} onChange={e=>setActiveBotId(e.target.value)} style={{ padding:'6px 8px', minWidth:220 }}>
            {bots.map(b => (
              <option key={b.botId} value={b.botId}>{b.botId}{b.title ? ` — ${b.title}` : ''}</option>
            ))}
            {!bots.find(b=>b.botId===activeBotId) && <option value={activeBotId}>{activeBotId}</option>}
          </select>
        </label>
        <span style={{ fontSize:12, color:'#666' }}>все /spec /generate /deploy идут с заголовком <code>x-bot-id: {activeBotId}</code></span>
      </div>

      {/* 2) Revisions (per bot) */}
      <section style={{ border:'1px solid #eee', borderRadius:12, padding:12, marginBottom:16 }}>
        <h2 style={{ marginTop:0 }}>2) Revisions — {activeBotId}</h2>
        <div style={{ fontSize:12, color:'#666', marginBottom:8 }}>
          {loadingRevs ? 'Loading…' : `Total: ${revisions.length}`}
          {activeRev ? ` · Active: ${activeRev}` : ''}
          <button onClick={loadRevisions} style={{ marginLeft:8 }}>Refresh</button>
        </div>
        <div style={{ display:'grid', gap:8 }}>
          {revisions.length === 0 && <div style={{fontSize:13}}>Нет ревизий для бота {activeBotId}</div>}
          {revisions.slice(0,30).map(r => (
            <div key={r.revHash} style={{ display:'flex', alignItems:'center', justifyContent:'space-between', border:'1px solid #eee', borderRadius:8, padding:'8px 10px' }}>
              <div style={{ fontFamily:'ui-monospace', fontSize:12, overflow:'hidden', textOverflow:'ellipsis' }}>
                {r.revHash}{activeRev===r.revHash ? <span style={{marginLeft:8, fontSize:11, color:'#0a0'}}>● active</span> : null}
                {r.createdAt ? <span style={{marginLeft:8, color:'#666'}}>{r.createdAt}</span> : null}
              </div>
              <div style={{ display:'flex', gap:8 }}>
                <button onClick={async ()=>{
                  try {
                    const res = await apiFetch('/deploy', { method:'POST', body: JSON.stringify({ botId: activeBotId, revHash: r.revHash }) })
                    await res.text(); append('[dep] ok '+r.revHash)
                    setActiveRev(r.revHash)
                  } catch(e:any){ append('[dep] error '+(e?.message||e)); alert(e?.message||e) }
                }}>Deploy</button>
                <button onClick={()=>navigator.clipboard?.writeText(r.revHash)}>Copy</button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div style={{ border: '1px solid #eee', borderRadius: 12, padding: 12 }}>
          <h2>1) Upload Spec</h2>
          <textarea
            value={spec}
            onChange={(e) => setSpec(e.target.value)}
            style={{ width: '100%', height: 220, fontFamily: 'ui-monospace', fontSize: 13 }}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button onClick={uploadSpec}>Upload /spec</button>
            <button onClick={generate}>Generate</button>
            <button onClick={uploadGenDeploy}>Upload→Generate→Deploy</button>

            <label style={{ marginLeft: 8, fontSize: 13 }}>
              Engine:&nbsp;
              <select
                value={engine}
                onChange={(e) => setEngine(e.target.value as 'local'|'gpt5')}
                style={{ padding: '4px 6px', fontSize: 13 }}
              >
                <option value="local">local</option>
                <option value="gpt5">gpt5</option>
              </select>
            </label>
          </div>
        </div>

        <div style={{ border: '1px solid #eee', borderRadius: 12, padding: 12 }}>
          <h2>Spec Assistant</h2>
          <div style={{ border:'1px solid #f1f1f1', borderRadius:8, padding:8, marginBottom:8, maxHeight:220, overflow:'auto', background:'#fafafa' }}>
            {nlChat.length === 0 && <div style={{fontSize:12, opacity:.7}}>Начните диалог: опишите бота, который нужен клиенту.</div>}
            {nlChat.map((m,i)=>(
              <div key={i} style={{fontSize:12, margin:'4px 0'}}>
                <b>{m.role==='user'?'Вы':'Ассистент'}:</b> {m.text}
              </div>
            ))}
          </div>
          <div style={{ display:'flex', gap:8, alignItems:'center', marginBottom:8 }}>
            <input value={chatInput} onChange={e=>setChatInput(e.target.value)} placeholder="Напишите сообщение для ассистента…" style={{ flex:1, padding:'6px 8px' }}/>
            <button onClick={sendChat} disabled={nlLoading || !chatInput.trim()}>Send</button>
            {nlLoading && <span className="spinner" aria-label="loading" />}
          </div>
          <textarea
            value={nlText}
            onChange={(e) => setNlText(e.target.value)}
            placeholder='Опиши изменения спеки на естественном языке'
            style={{ width: '100%', height: 120, fontFamily: 'ui-monospace', fontSize: 13 }}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems:'center' }}>
            <button onClick={nlPropose} disabled={nlLoading}>
              {nlLoading ? 'Propose Patch' : 'Propose Patch'}
            </button>
            {nlLoading && <span className="spinner" aria-label="loading" />}
            <button onClick={applyNlPatchLocally}>Apply Patch (local)</button>
          </div>
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 12, opacity: .7, marginBottom: 4 }}>Последний ответ (Patch или полная спека):</div>
            <pre style={{ fontFamily: 'ui-monospace', fontSize: 12, maxHeight: 160, overflow: 'auto', background:'#fafafa', padding:8, borderRadius:8 }}>{nlLastPatch || '—'}</pre>
          </div>
        </div>

        <div style={{ border: '1px solid #eee', borderRadius: 12, padding: 12 }}>
          <h2>3) Webhook test → echo</h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              value={testText}
              onChange={(e) => setTestText(e.target.value)}
              placeholder="/start"
              style={{ padding: '6px 8px', fontSize: 13, minWidth: 200 }}
            />
            <button onClick={testWebhook}>Send test /wh</button>
          </div>
        </div>

        <div style={{ border: '1px solid #eee', borderRadius: 12, padding: 12 }}>
          <h2>SSE / Logs</h2>
          <div style={{ fontFamily: 'ui-monospace', fontSize: 12, whiteSpace: 'pre-wrap', lineHeight: 1.35, maxHeight: 300, overflow: 'auto' }}>
            {log.map((x, i) => <div key={i}>{x}</div>)}
          </div>
          <div style={{ display:'flex', gap:8, marginTop:8 }}>
            <button onClick={fetchMetrics}>Load metrics</button>
            <button onClick={fetchDLQ}>Load DLQ</button>
          </div>
        </div>
      </section>
    </div>
  )
}
