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
  const [statusType, setStatusType] = useState('') // '', 'ok', 'error', 'info'
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

  const setStatusMsg = (msg, type = '') => {
    setStatus(msg)
    setStatusType(type)
  }

  const handleCheck = async (type) => {
    if (!driverName.trim()) {
      return setStatusMsg('❌ Please enter the driver name.', 'error')
    }

    if (!currentGeofence) {
      return setStatusMsg('⏳ Still loading location settings, please try again.', 'info')
    }

    setIsLoading(true)

    try {
      // ---------- GPS ----------
      setStatusMsg('📍 Getting your location… (tap Allow if prompted)', 'info')
      const pos = await getPosition()

      // ---------- Insert Directly ----------
      setStatusMsg('💾 Recording attendance…', 'info')

      // We send exactly what the user typed. The database trigger will handle the logic.
      const { error } = await supabase.from('attendance').insert([{
        driver_name: driverName.trim(),
        plate_number: plateNumber.trim().toUpperCase(),
        action_type: type,
        latitude:   pos?.latitude  ?? null,
        longitude:  pos?.longitude ?? null,
        accuracy:   pos?.accuracy  ?? null,
        geo_lat:    currentGeofence.lat,
        geo_lng:    currentGeofence.lng,
        geo_radius: currentGeofence.radiusMeters,
      }])

      if (error) {
        const msg = error.message || ''
        // If your SQL trigger rejects it, it will pass the error message here
        if (msg.toLowerCase().includes('already clocked in')) {
          setStatusMsg('❌ Already clocked in. Please TIME OUT first.', 'error')
        } else if (msg.toLowerCase().includes('no open clock-in')) {
          setStatusMsg(
            '❌ No active TIME IN found. Please TIME IN first. ' +
            '(If you are sure you already timed in, ask admin to check your record.)',
            'error'
          )
        } else {
          setStatusMsg(`❌ Database Error: ${msg}`, 'error')
        }
        return
      }

      setStatusMsg(
        pos
          ? `✅ Successfully clocked ${type.toUpperCase()}!`
          : `✅ Clocked ${type.toUpperCase()} (location unavailable)`,
        'ok'
      )
      setDriverName('')
      setPlateNumber('')
    } catch (e) {
      console.error(e)
      setStatusMsg(`❌ Unexpected error: ${e.message}`, 'error')
    } finally {
      setIsLoading(false)
    }
  }

  const statusColor =
    statusType === 'ok' ? '#2e7d32'
    : statusType === 'error' ? '#c62828'
    : statusType === 'info' ? '#1565c0'
    : '#000'

  return (
    <div style={{ backgroundColor: 'white', padding: '30px', borderRadius: '12px', width: '100%', maxWidth: '400px', margin: 'auto', marginTop: '50px', color: '#000' }}>
      <h2 style={{ textAlign: 'center', color: '#000' }}>Driver Check-In</h2>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
        <input
          type="text"
          placeholder="Driver Name"
          value={driverName}
          onChange={(e) => { setDriverName(e.target.value); setStatus('') }}
          style={{ padding: '12px', borderRadius: '6px', border: '1px solid #ccc', color: '#000', backgroundColor: '#fff', fontSize: '16px' }}
          disabled={isLoading}
          autoComplete="off"
        />
        <input
          type="text"
          placeholder="Plate Number"
          value={plateNumber}
          onChange={(e) => { setPlateNumber(e.target.value); setStatus('') }}
          style={{ padding: '12px', borderRadius: '6px', border: '1px solid #ccc', color: '#000', backgroundColor: '#fff', fontSize: '16px' }}
          disabled={isLoading}
          autoComplete="off"
        />
        <div style={{ display: 'flex', gap: '10px', marginTop: '10px' }}>
          <button
            onClick={() => handleCheck('in')}
            style={{ flex: 1, padding: '14px', backgroundColor: '#2e7d32', color: 'white', border: 'none', borderRadius: '6px', fontWeight: 'bold', cursor: isLoading ? 'not-allowed' : 'pointer', opacity: isLoading ? 0.6 : 1 }}
            disabled={isLoading}
          >
            TIME IN
          </button>
          <button
            onClick={() => handleCheck('out')}
            style={{ flex: 1, padding: '14px', backgroundColor: '#d32f2f', color: 'white', border: 'none', borderRadius: '6px', fontWeight: 'bold', cursor: isLoading ? 'not-allowed' : 'pointer', opacity: isLoading ? 0.6 : 1 }}
            disabled={isLoading}
          >
            TIME OUT
          </button>
        </div>
      </div>

      {status && (
        <p style={{ textAlign: 'center', marginTop: '20px', fontWeight: 'bold', color: statusColor, whiteSpace: 'pre-wrap' }}>
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
          <div style={{ textAlign: 'center', marginTop: '50px', color: '#000' }}>
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