import { motion } from 'framer-motion'
import AiChatPane from '../components/AiChatPane'
import App from '../App'

export default function DevPanels({ panel, botId }:{ panel:'chat'|'emu'|'both', botId:string }) {
  const showChat = panel === 'chat' || panel === 'both'
  const showEmu  = panel === 'emu'  || panel === 'both'

  return (
    <div style={{
      maxWidth:1400, width:'100%', margin:'0 auto 20px', padding:'0 16px',
      display:'grid',
      gridTemplateColumns: panel==='chat' ? '1fr' : panel==='emu' ? '1fr' : 'minmax(420px, 560px) 1fr',
      gap: 16
    }}>
      {showChat && (
        <motion.div
          initial={{ y:8, opacity:0 }} animate={{ y:0, opacity:1 }}
          transition={{ duration:.25, ease:[0.2,0.8,0.2,1] }}
          style={{ minHeight:'65vh', maxHeight:'78vh', border:'1px solid #1e2940', borderRadius:12, overflow:'hidden', background:'#0b1220' }}
        >
          <AiChatPane />
        </motion.div>
      )}

      {showEmu && (
        <motion.div
          initial={{ y:8, opacity:0 }} animate={{ y:0, opacity:1 }}
          transition={{ duration:.25, ease:[0.2,0.8,0.2,1] }}
          style={{ minHeight:'65vh', maxHeight:'78vh', border:'1px solid #1e2940', borderRadius:12, overflow:'hidden', background:'#0b1220' }}
        >
          {/* Используем текущий App как готовую пару панелей */}
          <App />
        </motion.div>
      )}
    </div>
  )
}


