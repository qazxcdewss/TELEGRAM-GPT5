import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

// ВАЖНО: стили TelegramUI
import '@telegram-apps/telegram-ui/dist/styles.css'
import './telegram-look.css'
// наш небольшой reset
import './tgui-reset.css'
// общие UI-токены и классы
import './styles/ui.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
