import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import AppRouter from './app/Router'

import '@telegram-apps/telegram-ui/dist/styles.css'
import './telegram-look.css'
import './tgui-reset.css'
import './styles/ui.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AppRouter />
    </BrowserRouter>
  </React.StrictMode>
)
