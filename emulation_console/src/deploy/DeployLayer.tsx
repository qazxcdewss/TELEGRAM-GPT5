import { useSearchParams, useNavigate } from 'react-router-dom'
import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { uploadSpec, generateCode, listRevisions, deployRev, getActiveBotId } from '../lib/api'
import { loadDraft } from '../lib/storage'

const API_BASE = (window as any).API || (import.meta as any).env?.VITE_API || 'http://localhost:3000'

// Мягкая нормализация через /api/nl/spec с fallback при TEXT_REQUIRED/422(draft)
async function tryNormalize(currentSpec: any) {
  const r = await fetch(`${API_BASE}/api/nl/spec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: 'Проверь и нормализуй JSON спецификации без изменений логики.',
      currentSpec
    })
  })
  if (r.status === 422) {
    try {
      const j = await r.json()
      if (j?.draft) return j.draft
    } catch {}
    throw new Error('AJV: схема невалидна (422). Исправьте черновик в чате.')
  }
  if (!r.ok) {
    try {
      const j = await r.json()
      if (j?.error?.code === 'TEXT_REQUIRED') return currentSpec
    } catch {}
    const t = await r.text().catch(()=> '')
    throw new Error(t || `HTTP_${r.status}`)
  }
  const j = await r.json().catch(()=> null)
  return j?.targetSpec || j?.spec || currentSpec
}

// Жёсткий санитайзер до строгой BotSpec v1
function hardNormalizeSpec(draft: any, botId: string) {
  const out: any = { meta: { botId: String(botId) } }

  // limits (optional)
  if (draft?.limits && typeof draft.limits === 'object') {
    const { botRps, chatRps } = draft.limits
    out.limits = {}
    if (Number.isInteger(botRps))  out.limits.botRps  = botRps
    if (Number.isInteger(chatRps)) out.limits.chatRps = chatRps
  }

  // commands → only {cmd, flow}
  const cmds = Array.isArray(draft?.commands) ? draft.commands : []
  out.commands = cmds.map((c: any, i: number) => {
    let cmd = String(c?.cmd ?? c?.name ?? '').trim()
    cmd = cmd.replace(/^\/+/, '').replace(/@.+$/, '')
    const flow = String(c?.flow ?? c?.name ?? `flow_${i}`).trim()
    return { cmd, flow }
  }).filter((c: any) => c.cmd && c.flow)

  // flows → keep only supported steps/fields
  const flows = Array.isArray(draft?.flows) ? draft.flows : []
  out.flows = flows.map((f: any, i: number) => {
    const name = String(f?.name ?? `flow_${i}`).trim()
    const stepsIn = Array.isArray(f?.steps) ? f.steps : []
    const steps = stepsIn.map((s: any) => {
      if (!s || typeof s !== 'object') return null
      if ('sendMessage' in s) {
        const text = String(s.sendMessage?.text ?? s.sendMessage?.message ?? s.text ?? '')
        return { type: 'sendMessage', text }
      }
      if (s.type === 'sendMessage') {
        return { type: 'sendMessage', text: String(s.text ?? '') }
      }
      if (s.type === 'goto') {
        return { type: 'goto', to: String(s.to ?? '') }
      }
      if (s.type === 'http') {
        const method = (s.method || 'POST').toUpperCase()
        return { type: 'http', url: String(s.url || ''), method: (method === 'GET' ? 'GET' : 'POST'), body: s.body ?? null }
      }
      return null
    }).filter(Boolean)
    return { name, steps }
  })

  return out
}

export default function DeployLayer() {
  const [q] = useSearchParams()
  const nav = useNavigate()
  const on = q.get('deploy') === '1'
  const botId = q.get('bot') || ''

  function close() {
    const p = new URLSearchParams(q); p.delete('deploy'); p.delete('bot'); nav({ search: p.toString() }, { replace:true })
  }

  return (
    <AnimatePresence>
      {on && (
        <motion.div
          key="deploylayer"
          initial={{ opacity:0 }} animate={{ opacity:1 }} exit={{ opacity:0 }}
          style={{
            position:'fixed', inset:0, zIndex:60, display:'grid', gridTemplateRows:'auto 1fr',
            background:'rgba(4,6,12,.55)', backdropFilter:'blur(8px)'
          }}
        >
          <div style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 14px' }}>
            <div style={{ fontWeight:700, color:'#fff' }}>Деплой в Telegram · bot: {botId || '—'}</div>
            <div style={{ marginLeft:'auto' }}>
              <button onClick={close} style={closeBtn}>Закрыть</button>
            </div>
          </div>

          <div style={{ display:'grid', placeItems:'center', padding:'16px' }}>
            <DeployPanel botId={botId} />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function DeployPanel({ botId }: { botId: string }) {
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState<'idle'|'saving'|'validating'|'webhook'|'done'|'error'>('idle')
  const [log, setLog] = useState<string[]>([])
  const append = (s:string)=>setLog(l=>[s, ...l].slice(0,200))

  async function deploy() {
    try {
      const activeId = botId || getActiveBotId()
      if (!activeId || !token.trim()) { alert('Укажи botId и токен'); return }

      // —— A) Normalize → Upload → Generate → Deploy из текущего draft
      // 0) берём черновик именно этого бота
      let draft = loadDraft(activeId)
      if (!draft) { throw new Error('Нет черновика спеки для этого бота') }

      // 0.1) мягкая нормализация на бэке (если сервер требует text — вернём исходный)
      append('[A/4] Нормализую spec (мягко)…')
      let normalized = await tryNormalize(draft)

      // 0.2) форсируем meta.botId и «жёстко» чистим от лишних полей
      normalized = hardNormalizeSpec(normalized, activeId)

      // 1) Upload /spec
      append('[B/4] Upload /spec…')
      const rSpec = await fetch(`${API_BASE}/spec`, {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'x-bot-id': activeId },
        body: JSON.stringify(normalized)
      })
      if (!rSpec.ok) throw new Error(await rSpec.text())
      const u = await rSpec.json()
      const specVersionId = Number(u?.specVersionId ?? u?.version)
      if (!specVersionId) throw new Error('specVersionId missing after /spec')

      // 2) Generate
      append('[C/4] Generate bot.js…')
      await generateCode({ botId: activeId, engine: 'local', specVersion: specVersionId })

      // 3) Берём самую свежую ревизию и деплоим
      await new Promise(r=>setTimeout(r, 400))
      const revs:any = await listRevisions(activeId)
      const arr = Array.isArray(revs?.items) ? revs.items : Array.isArray(revs) ? revs : []
      const latest = arr[0]?.revHash || arr[0]?.rev_hash
      if (!latest) throw new Error('Нет ревизий после generate')
      append(`[D/4] Deploy rev ${latest}…`)
      await deployRev(activeId, latest)

      // —— B) Сохранить токен → Validate → SetWebhook
      setBusy('saving'); append('[1/3] Сохраняю токен…')
      await fetch(`${API_BASE}/api/bots/${encodeURIComponent(activeId)}/token`, {
        method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ token })
      }).then(r=>r.ok?r.json():r.text().then(t=>Promise.reject(t)))

      setBusy('validating'); append('[2/3] Валидирую токен (getMe)…')
      await fetch(`${API_BASE}/api/bots/${encodeURIComponent(activeId)}/validate`, {
        method:'POST'
      }).then(r=>r.ok?r.json():r.text().then(t=>Promise.reject(t)))

      setBusy('webhook'); append('[3/3] Выставляю вебхук…')
      await fetch(`${API_BASE}/api/bots/${encodeURIComponent(activeId)}/setWebhook`, {
        method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({})
      }).then(r=>r.ok?r.json():r.text().then(t=>Promise.reject(t)))

      setBusy('done'); append('Готово! Вебхук выставлен, бот подключён.')
    } catch (e:any) {
      setBusy('error'); append('Ошибка: '+(e?.message || e))
      alert('Деплой не удался: ' + (e?.message || e))
    }
  }

  return (
    <div style={{
      width:'min(720px, 92vw)', background:'#0b1220', color:'#e5e7eb',
      border:'1px solid #1e2940', borderRadius:12, padding:16, boxShadow:'0 12px 40px rgba(0,0,0,.35)'
    }}>
      <div style={{ fontWeight:700, fontSize:18, marginBottom:8 }}>Подключение бота к Telegram</div>
      <div style={{ fontSize:13, opacity:.8, marginBottom:12 }}>
        Введите токен от BotFather. Мы сохраним его, проверим через <code>getMe</code> и выставим вебхук.
      </div>

      <label style={{ fontSize:12, opacity:.8 }}>BotFather Token</label>
      <input
        value={token} onChange={e=>setToken(e.target.value)} placeholder="123456:AA..."
        style={inputStyle}
      />

      <div style={{ display:'flex', gap:8, marginTop:12 }}>
        <button onClick={deploy} disabled={!token.trim() || busy!=='idle'} style={{ ...btn, opacity:(!token.trim()||busy!=='idle')? .6 : 1 }}>
          {busy==='idle' && 'Деплой'}
          {busy==='saving' && 'Сохранение…'}
          {busy==='validating' && 'Проверка…'}
          {busy==='webhook' && 'Вебхук…'}
          {busy==='done' && 'Готово'}
          {busy==='error' && 'Повторить'}
        </button>
        <button onClick={()=>{ setToken(''); setBusy('idle'); setLog([]) }} style={btnAlt}>Сбросить</button>
      </div>

      <div style={{ marginTop:12, fontSize:12, opacity:.8 }}>
        Логи:
      </div>
      <pre style={logStyle}>{log.join('\n')}</pre>

      <div style={{ fontSize:12, opacity:.7, marginTop:8 }}>
        Вебхук вычисляется автоматически (PUBLIC_BASE / ngrok / заголовки).
      </div>
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  width:'100%', marginTop:6, padding:'10px 12px', borderRadius:8,
  border:'1px solid #28324a', background:'#0e1426', color:'#e5e7eb'
}
const btn: React.CSSProperties = { background:'#2b74ff', color:'#fff', border:0, borderRadius:999, padding:'10px 14px', fontWeight:700, cursor:'pointer' }
const btnAlt: React.CSSProperties = { background:'#18223a', color:'#e5e7eb', border:'1px solid #28324a', borderRadius:999, padding:'10px 14px', fontWeight:600, cursor:'pointer' }
const closeBtn: React.CSSProperties = { background:'#c22', color:'#fff', border:0, borderRadius:999, padding:'8px 12px', fontWeight:700, cursor:'pointer' }
const logStyle: React.CSSProperties = {
  marginTop:8, padding:10, maxHeight:180, overflow:'auto',
  border:'1px solid #28324a', borderRadius:8, background:'#0a0f1a', color:'#cbd5e1'
}

/* withBotId used earlier, keep it for clarity (read by sanitizer too) */
function withBotId(spec: any, botId: string) {
  const s = JSON.parse(JSON.stringify(spec || {}))
  if (!s.meta) s.meta = {}
  s.meta.botId = botId
  return s
}


