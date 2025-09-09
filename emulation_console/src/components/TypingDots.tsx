export default function TypingDots() {
  return (
    <span aria-label="typing" style={{ display:'inline-flex', gap:4 }}>
      {[0,1,2].map(i => (
        <span key={i} style={{
          width:6, height:6, borderRadius:999, background:'#9ca3af',
          opacity:.6, animation:'blink 1.4s infinite', animationDelay:`${i*0.2}s`
        }}/>
      ))}
      <style>{`@keyframes blink{0%,80%,100%{opacity:.2}40%{opacity:1}}`}</style>
    </span>
  )
}



