import { useState, useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { supabase } from './supabaseClient'
import QRCode from 'react-qr-code'
import Login from './pages/Login'
import AdminDashboard from './pages/AdminDashboard'

// ---------- GPS helper ----------
const getPosition = () =>
  new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null)
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    )
  })

// ---------- Fallback geofence if DB row missing ----------
const FALLBACK_GEOFENCE = { lat: 14.5995, lng: 120.9842, radiusMeters: 300 }

// --- DRIVER SCAN COMPONENT ---
function DriverScan() {
  const [driverName, setDriverName] = useState('')
  const [plateNumber, setPlateNumber] = useState('')
  const [status, setStatus] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [currentGeofence, setCurrentGeofence] = useState(null)
  const [geofenceError, setGeofenceError] = useState('')

  // Load the active geofence once when the scan page opens
  useEffect(() => {
    let cancelled = false
    supabase
      .from('geofence_settings')
      .select('*')
      .eq('id', 1)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) {
          // Table may not exist yet — fall back gracefully
          console.warn('geofence_settings load failed:', error.message)
          setCurrentGeofence(FALLBACK_GEOFENCE)
          setGeofenceError('')
          return
        }
        if (data) {
          setCurrentGeofence({
            lat: Number(data.lat),
            lng: Number(data.lng),
            radiusMeters: Number(data.radius_meters),
          })
        } else {
          setCurrentGeofence(FALLBACK_GEOFENCE)
        }
      })
    return () => { cancelled = true }
  }, [])

  const handleCheck = async (type) => {
    if (!driverName.trim() || !plateNumber.trim()) {
      return setStatus('Please enter both fields.')
    }

    if (!currentGeofence) {
      return setStatus('Still loading location settings, please try again.')
    }

    setIsLoading(true)
    setStatus('Getting your location… (tap Allow if prompted)')

    const pos = await getPosition()

    setStatus('Recording attendance…')

    // ---------- THE EXPANDED INSERT ----------
    const { error } = await supabase.from('attendance').insert([{
      driver_name: driverName.trim(),
      plate_number: plateNumber.trim().toUpperCase(),
      action_type: type,                                // 'in' or 'out'
      latitude:   pos?.latitude  ?? null,
      longitude:  pos?.longitude ?? null,
      accuracy:   pos?.accuracy  ?? null,
      // Geofence snapshot for this exact scan:
      geo_lat:    currentGeofence.lat,
      geo_lng:    currentGeofence.lng,
      geo_radius: currentGeofence.radiusMeters,
    }])
    // ----------------------------------------

    setIsLoading(false)

    if (error) {
      // If the SQL trigger rejected a duplicate/stray scan, show it clearly
      const msg = error.message || ''
      if (msg.toLowerCase().includes('already clocked in')) {
        setStatus('❌ You are already clocked in. Please TIME OUT first.')
      } else if (msg.toLowerCase().includes('no open clock-in')) {
        setStatus('❌ No active TIME IN found. Please TIME IN first.')
      } else {
        setStatus(`❌ Error: ${msg}`)
      }
      return
    }

    setStatus(
      pos
        ? `✅ Successfully clocked ${type.toUpperCase()}!`
        : `✅ Clocked ${type.toUpperCase()} (location unavailable)`
    )
    setDriverName('')
    setPlateNumber('')
  }

  return (
    <div style={{ backgroundColor: 'white', padding: '30px', borderRadius: '12px', width: '100%', maxWidth: '400px', margin: 'auto', marginTop: '50px' }}>
      <h2 style={{ textAlign: 'center' }}>Driver Check-In</h2>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
        <input
          type="text"
          placeholder="Driver Name"
          value={driverName}
          onChange={(e) => { setDriverName(e.target.value); setStatus('') }}
          style={{ padding: '12px', borderRadius: '6px', border: '1px solid #ccc' }}
          disabled={isLoading}
        />
        <input
          type="text"
          placeholder="Plate Number"
          value={plateNumber}
          onChange={(e) => { setPlateNumber(e.target.value); setStatus('') }}
          style={{ padding: '12px', borderRadius: '6px', border: '1px solid #ccc' }}
          disabled={isLoading}
        />
        <div style={{ display: 'flex', gap: '10px', marginTop: '10px' }}>
          <button
            onClick={() => handleCheck('in')}
            style={{ flex: 1, padding: '14px', backgroundColor: '#2e7d32', color: 'white', border: 'none', borderRadius: '6px', fontWeight: 'bold' }}
            disabled={isLoading}
          >
            TIME IN
          </button>
          <button
            onClick={() => handleCheck('out')}
            style={{ flex: 1, padding: '14px', backgroundColor: '#d32f2f', color: 'white', border: 'none', borderRadius: '6px', fontWeight: 'bold' }}
            disabled={isLoading}
          >
            TIME OUT
          </button>
        </div>
      </div>

      {status && (
        <p style={{ textAlign: 'center', marginTop: '20px', fontWeight: 'bold' }}>
          {status}
        </p>
      )}

      {geofenceError && (
        <p style={{ textAlign: 'center', marginTop: '10px', fontSize: '12px', color: '#999' }}>
          {geofenceError}
        </p>
      )}
    </div>
  )
}

// --- MAIN APP ROUTING ---
export default function App() {
  const [session, setSession] = useState(null)

  useEffect(() => {
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
        <Route path="/admin" element={
          session ? <AdminDashboard /> : <Login />
        } />

        <Route path="/scan" element={<DriverScan />} />

        <Route path="/" element={
          <div style={{ textAlign: 'center', marginTop: '50px' }}>
            <h2>Admin Station</h2>
            <p>Print this QR code and post it on the wall.</p>
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