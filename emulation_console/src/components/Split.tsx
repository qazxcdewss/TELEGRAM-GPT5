import { useEffect, useRef, useState } from 'react'

export default function Split(props:{ left:React.ReactNode; right:React.ReactNode; storageKey?:string }) {
  const key = props.storageKey || 'emul.split.w'
  const [w, setW] = useState<number>(() => Number(localStorage.getItem(key)) || 440)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(()=>{ localStorage.setItem(key, String(w)) },[w])

  useEffect(()=>{
    const el = ref.current
    if (!el) return
    let drag = false
    function down(e:MouseEvent){ drag = (e.button===0) }
    function move(e:MouseEvent){ if(!drag) return; setW(Math.min(Math.max(320, e.clientX), 800)) }
    function up(){ drag=false }
    el.addEventListener('mousedown', down); window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
    return ()=>{ el.removeEventListener('mousedown', down); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
  },[])

  return (
    <div style={{display:'grid', gridTemplateColumns:`${w}px 6px 1fr`, height:'100%'}}>
      <div style={{overflow:'hidden'}}>{props.left}</div>
      <div ref={ref} style={{cursor:'col-resize', background:'transparent'}} />
      <div style={{overflow:'hidden'}}>{props.right}</div>
    </div>
  )
}
