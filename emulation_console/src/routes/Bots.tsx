import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import AddBotModal from '../components/AddBotModal'
import { listBots, createBot } from '../lib/api'

type BotItem = { botId:string; title?:string; status?:string; updatedAt?:string }
const initialBots: BotItem[] = []

export default function Bots() {
  const nav = useNavigate()
  const [q] = useSearchParams()
  const [bots, setBots] = useState<BotItem[]>([])
  const [showNew, setShowNew] = useState(false)

  useEffect(()=>{
    ;(async()=>{
      try {
        const j = await listBots()
        const arr = Array.isArray(j) ? j : Array.isArray(j?.bots) ? j.bots : []
        setBots(arr.map((b:any)=>({ botId: String(b.bot_id || b.botId || b.id), title: b.title, status: b.status, updatedAt: b.updatedAt })))
      } catch {}
    })()
  },[])

  return (
    <div style={{ minHeight:'100vh', width:'100vw', background:'#0b0f1d', color:'#e5e7eb' }}>
      {/* язычок разработчика удалён */}
      <div style={{ width:'100%', margin:'24px 0', padding:'0 24px 24px' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
          <h1 style={{ margin:0, fontSize:22 }}>Мои боты</h1>
          <button
            onClick={()=>{ setShowNew(true) }}
            style={{ background:'#2b74ff', color:'#fff', border:0, borderRadius:999, padding:'10px 14px', fontWeight:700, cursor:'pointer' }}
          >
            Создать бота
          </button>
        </div>

        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(260px, 1fr))', gap:16 }}>
          {bots.map(b=> (
            <div key={b.botId} style={{ background:'#111729', border:'1px solid #1e2940', borderRadius:12, padding:14 }}>
              <div style={{ fontWeight:700 }}>{b.title}</div>
              <div style={{ fontSize:12, opacity:.7, margin:'6px 0 10px' }}>status: {b.status || 'unknown'} · updated: {b.updatedAt || '-'}</div>
              <div style={{ display:'flex', gap:8 }}>
                <button onClick={()=>nav(`/bots?dev=1&panel=both&bot=${encodeURIComponent(b.botId)}`)} style={cardBtn}>Dev-режим</button>
                <button onClick={()=>nav(`/bots?bot=${encodeURIComponent(b.botId)}&panel=emu`)} style={cardBtnAlt}>Открыть эмулятор</button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <AddBotModal
        open={showNew}
        onClose={()=>setShowNew(false)}
        onCreated={async (id, title)=>{
          try {
            const j = await createBot(id, title || id)
            setBots(prev => [{ botId: id, title: j?.title || title || id }, ...prev.filter(b=>b.botId!==id)])
            setShowNew(false)
            nav(`/bots?dev=1&panel=both&bot=${encodeURIComponent(id)}`)
          } catch (e:any) {
            alert('Не удалось создать бота: ' + (e?.message || e))
          }
        }}
      />
    </div>
  )
}
const cardBtn: React.CSSProperties = { background:'#2b74ff', color:'#fff', border:0, borderRadius:8, padding:'8px 10px', fontWeight:700, cursor:'pointer' }
const cardBtnAlt: React.CSSProperties = { background:'#18223a', color:'#e5e7eb', border:'1px solid #28324a', borderRadius:8, padding:'8px 10px', fontWeight:600, cursor:'pointer' }

