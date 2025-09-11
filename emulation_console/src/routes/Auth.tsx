import { useNavigate, useSearchParams } from 'react-router-dom'

export default function Auth() {
  const nav = useNavigate()
  const [q] = useSearchParams()
  const from = q.get('from') || '/bots'

  return (
    <div style={{ height:'100vh', width:'100vw', display:'flex', justifyContent:'center', alignItems:'center', background:'radial-gradient(1200px 600px at 50% -10%, #1b2340 0%, #0b0f1d 60%)', color:'#e5e7eb' }}>
      <div style={{ background:'#111729', border:'1px solid #1e2940', padding:24, borderRadius:12, width:360, boxShadow:'0 20px 60px rgba(0,0,0,.35)' }}>
        <div style={{ fontWeight:700, marginBottom:12 }}>Вход / Регистрация</div>
        <input placeholder="Email" style={iStyle}/>
        <input placeholder="Пароль" type="password" style={{...iStyle, marginTop:8}}/>
        <button style={{...bStyle, marginTop:12}} onClick={()=>nav(from, { replace:true })}>Войти</button>
        <div style={{ fontSize:12, opacity:.7, marginTop:8 }}>нажмите «Войти» для перехода в кабинет…</div>
      </div>
    </div>
  )
}
const iStyle: React.CSSProperties = { width:'100%', padding:'10px 12px', borderRadius:8, border:'1px solid #28324a', background:'#0e1426', color:'#e5e7eb' }
const bStyle: React.CSSProperties = { width:'100%', padding:'10px 12px', borderRadius:999, border:0, background:'#2b74ff', color:'#fff', fontWeight:700 }


