import { useState, useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { supabase } from './supabaseClient'
import QRCode from 'react-qr-code'
import Login from './pages/Login'
import AdminDashboard from './pages/AdminDashboard'

// --- DRIVER SCAN COMPONENT ---
function DriverScan() {
  const [driverName, setDriverName] = useState('')
  const [plateNumber, setPlateNumber] = useState('')
  const [status, setStatus] = useState('')
  const [isLoading, setIsLoading] = useState(false)

  const handleCheck = async (type) => {
    if (!driverName.trim() || !plateNumber.trim()) return setStatus('Please enter both fields.')
    
    setIsLoading(true)
    setStatus('Processing...')

    const { error } = await supabase.from('attendance').insert([{ 
      driver_name: driverName.trim(), 
      plate_number: plateNumber.trim().toUpperCase(),
      action_type: type 
    }])

    setIsLoading(false)

    if (error) {
      setStatus(`❌ Error: ${error.message}`)
    } else {
      setStatus(`✅ Successfully clocked ${type.toUpperCase()}!`)
      setDriverName(''); setPlateNumber('')
    }
  }

  return (
    <div style={{ backgroundColor: 'white', padding: '30px', borderRadius: '12px', width: '100%', maxWidth: '400px', margin: 'auto', marginTop: '50px' }}>
      <h2 style={{ textAlign: 'center' }}>Driver Check-In</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
        <input type="text" placeholder="Driver Name" value={driverName} onChange={(e) => {setDriverName(e.target.value); setStatus('');}} style={{ padding: '12px', borderRadius: '6px', border: '1px solid #ccc' }} disabled={isLoading}/>
        <input type="text" placeholder="Plate Number" value={plateNumber} onChange={(e) => {setPlateNumber(e.target.value); setStatus('');}} style={{ padding: '12px', borderRadius: '6px', border: '1px solid #ccc' }} disabled={isLoading}/>
        <div style={{ display: 'flex', gap: '10px', marginTop: '10px' }}>
          <button onClick={() => handleCheck('in')} style={{ flex: 1, padding: '14px', backgroundColor: '#2e7d32', color: 'white', border: 'none', borderRadius: '6px', fontWeight: 'bold' }} disabled={isLoading}>TIME IN</button>
          <button onClick={() => handleCheck('out')} style={{ flex: 1, padding: '14px', backgroundColor: '#d32f2f', color: 'white', border: 'none', borderRadius: '6px', fontWeight: 'bold' }} disabled={isLoading}>TIME OUT</button>
        </div>
      </div>
      {status && <p style={{ textAlign: 'center', marginTop: '20px', fontWeight: 'bold' }}>{status}</p>}
    </div>
  )
}

// --- MAIN APP ROUTING ---
export default function App() {
  const [session, setSession] = useState(null)

  useEffect(() => {
    // Check if Admin is logged in
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
    })
    const { data: authListener } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
    })
    return () => authListener.subscription.unsubscribe()
  }, [])

  return (
    <BrowserRouter>
      <Routes>
        {/* Admin Routes */}
        <Route path="/admin" element={
          session ? <AdminDashboard /> : <Login />
        } />

        {/* Driver Scan Route */}
        <Route path="/scan" element={<DriverScan />} />

        {/* Public QR Code Display */}
        <Route path="/" element={
          <div style={{ textAlign: 'center', marginTop: '50px' }}>
            <h2>Admin Station</h2>
            <p>Print this QR code and post it on the wall.</p>
            {/* The QR code points to the /scan route */}
            <div style={{ backgroundColor: 'white', padding: '20px', display: 'inline-block', borderRadius: '8px', marginTop: '20px' }}>
              <QRCode value={window.location.origin + '/scan'} size={200} />
            </div>
            <p style={{ marginTop: '30px' }}>
              <a href="/admin" style={{ color: '#1976d2' }}>Go to Admin Login</a>
            </p>
          </div>
        } />
      </Routes>
    </BrowserRouter>
  )
}