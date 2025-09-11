import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

export default function AddBotModal({
  open, onClose, onCreated
}: { open: boolean; onClose: () => void; onCreated: (botId: string, title?: string) => void }) {
  const [botId, setBotId] = useState('')
  const [title, setTitle] = useState('')
  const disabled = !botId.trim()

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          style={{ position:'fixed', inset:0, zIndex:60, background:'rgba(0,0,0,.45)', display:'grid', placeItems:'center' }}
          onClick={onClose}
        >
          <motion.div
            initial={{ y: 16, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 16, opacity: 0 }}
            transition={{ duration: .22, ease:[0.2,0.8,0.2,1] }}
            onClick={e=>e.stopPropagation()}
            style={{ width:420, background:'#0b1220', color:'#e5e7eb', border:'1px solid #1e2940',
                     borderRadius:12, padding:16, boxShadow:'0 12px 40px rgba(0,0,0,.35)' }}
          >
            <div style={{ fontWeight:700, fontSize:18, marginBottom:10 }}>Создать бота</div>

            <label style={{ fontSize:12, opacity:.8 }}>Bot ID</label>
            <input
              value={botId} onChange={e=>setBotId(e.target.value)} placeholder="my-bot-1"
              style={inputStyle}
            />

            <label style={{ fontSize:12, opacity:.8, marginTop:10 }}>Title (необязательно)</label>
            <input
              value={title} onChange={e=>setTitle(e.target.value)} placeholder="My Bot"
              style={inputStyle}
            />

            <div style={{ display:'flex', gap:8, justifyContent:'flex-end', marginTop:14 }}>
              <button onClick={onClose} style={btnAlt}>Отмена</button>
              <button
                disabled={disabled} style={{ ...btn, opacity: disabled ? .6 : 1 }}
                onClick={()=> onCreated(botId.trim(), title.trim() || undefined)}
              >Создать</button>
            </div>

            <div style={{ fontSize:12, opacity:.7, marginTop:10 }}>
              Токен BotFather можно добавить позже — после разработки и тестов.
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
const inputStyle: React.CSSProperties = {
  width:'100%', marginTop:6, padding:'10px 12px', borderRadius:8,
  border:'1px solid #28324a', background:'#0e1426', color:'#e5e7eb'
}
const btn: React.CSSProperties = { background:'#2b74ff', color:'#fff', border:0, borderRadius:999, padding:'10px 14px', fontWeight:700, cursor:'pointer' }
const btnAlt: React.CSSProperties = { background:'#18223a', color:'#e5e7eb', border:'1px solid #28324a', borderRadius:999, padding:'10px 14px', fontWeight:600, cursor:'pointer' }


