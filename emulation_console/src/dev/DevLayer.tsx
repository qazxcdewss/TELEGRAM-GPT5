import { useSearchParams, useNavigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import DevPanels from './DevPanels'

export default function DevLayer() {
  const [q] = useSearchParams()
  const nav = useNavigate()
  const on = q.get('dev') === '1'
  const panel = (q.get('panel') || 'both') as 'chat'|'emu'|'both'
  const botId = q.get('bot') || 'my-bot-1'

  function close() {
    const p = new URLSearchParams(q); p.delete('dev'); p.delete('panel')
    nav({ search: p.toString() }, { replace:true })
  }

  return (
    <AnimatePresence>
      {on && (
        <motion.div
          key="devlayer"
          initial={{ opacity:0 }}
          animate={{ opacity:1 }}
          exit={{ opacity:0 }}
          style={{
            position:'fixed', inset:0, zIndex:50, display:'grid',
            gridTemplateRows:'auto 1fr', background:'rgba(4,6,12,.55)', backdropFilter:'blur(8px)'
          }}
        >
          {/* бар */}
          <div style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 14px' }}>
            <div style={{ fontWeight:700, color:'#fff' }}>Dev-режим · bot: {botId}</div>
            <div style={{ marginLeft:'auto', display:'flex', gap:8 }}>
              <button onClick={()=>togglePanel('chat')} style={tab(panel==='chat')}>Только чат</button>
              <button onClick={()=>togglePanel('emu')}  style={tab(panel==='emu')}>Только эмулятор</button>
              <button onClick={()=>togglePanel('both')} style={tab(panel==='both')}>Оба окна</button>
              <button onClick={close} style={closeBtn}>Закрыть</button>
            </div>
          </div>

          {/* панели */}
          <DevPanels panel={panel} botId={botId} />
        </motion.div>
      )}
    </AnimatePresence>
  )

  function togglePanel(next:'chat'|'emu'|'both') {
    const p = new URLSearchParams(q)
    p.set('panel', next)
    if (!p.get('dev')) p.set('dev','1')
    nav({ search: p.toString() }, { replace:true })
  }
}

const tab = (active:boolean): React.CSSProperties => ({
  background: active ? '#2b74ff' : '#111729',
  color:'#fff', border:'1px solid #1e2940', borderRadius:999, padding:'8px 12px', cursor:'pointer', fontWeight:700
})
const closeBtn: React.CSSProperties = ({ background:'#c22', color:'#fff', border:0, borderRadius:999, padding:'8px 12px', cursor:'pointer', fontWeight:700 })


