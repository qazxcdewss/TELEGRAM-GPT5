import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, useAnimationControls } from 'framer-motion'

export default function Landing() {
  const nav = useNavigate()
  const ctrl = useAnimationControls()

  async function start() {
    // анимация взлёта: вверх, масштаб, fade
    await ctrl.start({
      y: -140, scale: 1.12, opacity: 0,
      transition: { duration: 0.55, ease: [0.2, 0.8, 0.2, 1] }
    })
    nav('/auth?from=/bots')
  }

  return (
    <div
      style={{
        height: '100vh',
        width: '100vw',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        // красивый фон на весь экран
        background: 'radial-gradient(1200px 600px at 50% -10%, #1b2340 0%, #0b0f1d 60%)'
      }}
    >
      <motion.button
        onClick={start}
        animate={ctrl}
        initial={{ y: 0, scale: 1, opacity: 0 }}
        // лёгкое появление при загрузке
        whileInView={{ opacity: 1 }}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.97 }}
        style={{
          background: '#2b74ff',
          color: '#fff',
          border: 0,
          padding: '16px 28px',
          borderRadius: 999,
          fontWeight: 700,
          fontSize: 18,
          cursor: 'pointer',
          boxShadow: '0 18px 60px rgba(43,116,255,.35)'
        }}
      >
        начать разработку
      </motion.button>

      {/* уважим reduced motion: если пользователь просит минимум движений — не анимируем, сразу навигируем */}
      <style>{`
        @media (prefers-reduced-motion: reduce) {
          .no-motion { display:none; }
        }
      `}</style>
    </div>
  )
}


