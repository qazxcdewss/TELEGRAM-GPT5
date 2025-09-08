import { type ReactNode } from 'react'

export default function MessageBubble({ role, children }:{role:'user'|'assistant'|'system'; children:ReactNode}) {
  const isUser = role==='user'
  const bg = role==='system' ? 'transparent' : isUser ? '#1f2937' : '#111827'
  const align = isUser ? 'flex-end' : 'flex-start'
  const color = role==='system' ? '#9ca3af' : '#e5e7eb'
  return (
    <div style={{ display:'flex', justifyContent: align }}>
      <div style={{
        maxWidth: 640, background:bg, color, border:'1px solid #1e293b', borderRadius: 16,
        padding: '10px 14px', lineHeight: 1.45, whiteSpace:'pre-wrap'
      }}>
        {children}
      </div>
    </div>
  )
}


