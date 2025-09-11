import { useSearchParams, useNavigate } from 'react-router-dom'
import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { uploadSpec, generateCode, listRevisions, deployRev } from '../lib/api'
import { loadDraft } from '../lib/storage'

const API_BASE = (window as any).API || (import.meta as any).env?.VITE_API || 'http://localhost:3000'

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
      if (!botId || !token.trim()) { alert('Укажи botId и токен'); return }

      // —— A) Upload → Generate → Deploy из текущего draft
      append('[A/3] Upload spec…')
      let draft = loadDraft(botId)
      if (!draft) { throw new Error('Нет черновика спеки для этого бота') }
      draft = withBotId(draft, botId)
      await uploadSpec(botId, draft)

      append('[B/3] Generate bot.js…')
      await generateCode({ botId, engine: 'local' })
      await new Promise(r=>setTimeout(r, 400))
      const revs:any = await listRevisions(botId)
      const arr = Array.isArray(revs?.items) ? revs.items : Array.isArray(revs) ? revs : []
      const latest = arr[0]?.revHash || arr[0]?.rev_hash
      if (!latest) throw new Error('No revisions after generate')
      append(`[C/3] Deploy rev ${latest}…')
      await deployRev(botId, latest)

      // —— B) Сохранить токен → Validate → SetWebhook
      setBusy('saving'); append('[1/3] Сохраняю токен…')
      await fetch(`${API_BASE}/api/bots/${encodeURIComponent(botId)}/token`, {
        method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ token })
      }).then(r=>r.ok?r.json():r.text().then(t=>Promise.reject(t)))

      setBusy('validating'); append('[2/3] Валидирую токен (getMe)…')
      await fetch(`${API_BASE}/api/bots/${encodeURIComponent(botId)}/validate`, {
        method:'POST'
      }).then(r=>r.ok?r.json():r.text().then(t=>Promise.reject(t)))

      setBusy('webhook'); append('[3/3] Выставляю вебхук…')
      await fetch(`${API_BASE}/api/bots/${encodeURIComponent(botId)}/setWebhook`, {
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

function withBotId(spec: any, botId: string) {
  const s = JSON.parse(JSON.stringify(spec || {}))
  if (!s.meta) s.meta = {}
  s.meta.botId = botId
  return s
}


