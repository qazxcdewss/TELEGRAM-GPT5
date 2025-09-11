import { Routes, Route, Navigate } from 'react-router-dom'
import Landing from '../routes/Landing'
import Auth from '../routes/Auth'
import Bots from '../routes/Bots'
import DevLayer from '../dev/DevLayer'
import DeployLayer from '../deploy/DeployLayer'

export default function AppRouter() {
  return (
    <>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/auth" element={<Auth />} />
        <Route path="/bots" element={<Bots />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <DevLayer />
      <DeployLayer />
    </>
  )
}


