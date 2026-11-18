import { useState, useEffect, useRef } from 'react'
import { BrowserRouter, Routes, Route, Link } from 'react-router-dom'
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
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    )
  })

// ---------- Fallback geofence (recorded with each scan, not used to block) ----------
const FALLBACK_GEOFENCE = { lat: 14.5995, lng: 120.9842, radiusMeters: 300 }

// ---------- Shared UI pieces ----------
function Shell({ children }) {
  return (
    <div className="nm-shell">
      <style>{css}</style>
      <main className="nm-card">{children}</main>
    </div>
  )
}

function Brand() {
  return (
    <div className="nm-brand">
      <div className="nm-logo" aria-hidden="true">
        <svg viewBox="0 0 40 40" width="28" height="28" fill="none">
          <circle cx="20" cy="20" r="10" stroke="#eaf6ff" strokeWidth="3.5" />
          <circle cx="20" cy="20" r="16" stroke="#eaf6ff" strokeOpacity=".35" strokeWidth="2" />
        </svg>
      </div>
      <span className="nm-wordmark">NEMINTSCO</span>
    </div>
  )
}

// ---------- CAMERA CAPTURE ----------
function CameraCapture({ type, onConfirm, onCancel }) {
  const videoRef = useRef(null)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)
  const [facing, setFacing] = useState('user')
  const [shot, setShot] = useState(null)

  useEffect(() => {
    if (shot) return
    let stream = null
    let cancelled = false
    setReady(false)

    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Camera is not supported on this browser.')
      return
    }

    navigator.mediaDevices
      .getUserMedia({
        video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 960 } },
        audio: false,
      })
      .then((s) => {
        if (cancelled) { s.getTracks().forEach((t) => t.stop()); return }
        stream = s
        if (videoRef.current) {
          videoRef.current.srcObject = s
          videoRef.current.play().catch(() => {})
        }
        setError('')
      })
      .catch(() => {
        setError('Camera access was blocked. Please allow camera permission and try again.')
      })

    return () => {
      cancelled = true
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [facing, shot])

  useEffect(() => () => { if (shot?.url) URL.revokeObjectURL(shot.url) }, [shot])

  const takePhoto = () => {
    const v = videoRef.current
    if (!v || !v.videoWidth) return
    const scale = Math.min(1, 960 / v.videoWidth)
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(v.videoWidth * scale)
    canvas.height = Math.round(v.videoHeight * scale)
    canvas.getContext('2d').drawImage(v, 0, 0, canvas.width, canvas.height)
    canvas.toBlob(
      (blob) => { if (blob) setShot({ blob, url: URL.createObjectURL(blob) }) },
      'image/jpeg',
      0.8
    )
  }

  const onFile = (e) => {
    const f = e.target.files?.[0]
    if (f) setShot({ blob: f, url: URL.createObjectURL(f) })
  }

  return (
    <div className="nm-cam-backdrop" role="dialog" aria-modal="true" aria-label="Take a photo">
      <div className="nm-cam">
        <h2 className="nm-cam-title">
          {shot ? 'Use this photo?' : `Take a photo to TIME ${type.toUpperCase()}`}
        </h2>

        <div className="nm-cam-frame">
          {shot ? (
            <img src={shot.url} alt="Captured" />
          ) : error ? (
            <p className="nm-cam-error">{error}</p>
          ) : (
            <video
              ref={videoRef}
              playsInline
              muted
              className={facing === 'user' ? 'mirror' : ''}
              onLoadedMetadata={() => setReady(true)}
            />
          )}
        </div>

        {shot ? (
          <div className="nm-cam-actions">
            <button type="button" className="nm-btn ghost" onClick={() => setShot(null)}>Retake</button>
            <button type="button" className="nm-btn in" onClick={() => onConfirm(shot.blob)}>
              Confirm TIME {type.toUpperCase()}
            </button>
          </div>
        ) : (
          <div className="nm-cam-actions">
            <button type="button" className="nm-btn ghost" onClick={onCancel}>Cancel</button>
            {error ? (
              <label className="nm-btn in nm-file-btn">
                Open camera
                <input type="file" accept="image/*" capture="user" onChange={onFile} hidden />
              </label>
            ) : (
              <>
                <button
                  type="button"
                  className="nm-btn ghost nm-flip"
                  onClick={() => setFacing((f) => (f === 'user' ? 'environment' : 'user'))}
                  aria-label="Switch camera"
                >⟲</button>
                <button type="button" className="nm-btn in" onClick={takePhoto} disabled={!ready}>
                  📸 Capture
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// --- DRIVER SCAN COMPONENT ---
function DriverScan() {
  const [driverName, setDriverName] = useState('')
  const [plateNumber, setPlateNumber] = useState('')
  const [status, setStatus] = useState('')
  const [statusType, setStatusType] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [activeType, setActiveType] = useState(null)
  const [currentGeofence, setCurrentGeofence] = useState(null)
  const [pendingType, setPendingType] = useState(null)
  // GPS fix obtained in step 1 — reused on submit so we don't ask twice
  const [verifiedPosition, setVerifiedPosition] = useState(null)

  // Load geofence settings (recorded with each scan; NOT used to block the driver)
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

  // STEP 1: require LOCATION ON, then open the camera.
  // (Geofence distance is NOT checked — only that GPS works.)
  const handleCheck = async (type) => {
    if (!driverName.trim()) {
      return setStatusMsg('❌ Please enter the driver name.', 'error')
    }
    if (!currentGeofence) {
      return setStatusMsg('⏳ Still loading location settings, please try again.', 'info')
    }

    setStatus('')
    setIsLoading(true)
    setActiveType(type)
    setVerifiedPosition(null)

    try {
      setStatusMsg('📍 Turning on location… (tap Allow if prompted)', 'info')
      const pos = await getPosition()

      if (!pos) {
        setStatusMsg(
          '❌ Location is turned off or blocked. Please enable GPS / allow location access in your browser, then try again.',
          'error'
        )
        setIsLoading(false)
        setActiveType(null)
        return
      }

      // ✅ Location is ON — proceed to camera
      setVerifiedPosition(pos)
      setStatusMsg('✅ Location is on. Opening camera…', 'ok')
      setIsLoading(false)
      setActiveType(null)
      setPendingType(type)
    } catch (e) {
      console.error(e)
      setStatusMsg(`❌ Location check failed: ${e.message}`, 'error')
      setIsLoading(false)
      setActiveType(null)
    }
  }

  // STEP 2: after photo is confirmed
  const submitAttendance = async (type, photoBlob) => {
    setPendingType(null)
    setIsLoading(true)
    setActiveType(type)
    let uploadedPath = null

    try {
      // Try a fresh fix; fall back to the one from step 1
      setStatusMsg('📍 Confirming location…', 'info')
      const pos = (await getPosition()) || verifiedPosition

      if (!pos) {
        setStatusMsg(
          '❌ Location is turned off or blocked. Please enable GPS / allow location access, then try again.',
          'error'
        )
        return
      }

      setStatusMsg('📤 Uploading photo…', 'info')
      const day = new Date().toISOString().slice(0, 10)
      uploadedPath = `${day}/${crypto.randomUUID()}.jpg`
      const { error: upErr } = await supabase.storage
        .from('attendance-photos')
        .upload(uploadedPath, photoBlob, { contentType: 'image/jpeg' })
      if (upErr) {
        uploadedPath = null
        setStatusMsg(`❌ Photo upload failed: ${upErr.message}`, 'error')
        return
      }
      const { data: pub } = supabase.storage
        .from('attendance-photos')
        .getPublicUrl(uploadedPath)

      setStatusMsg('💾 Recording attendance…', 'info')

      const { error } = await supabase.from('attendance').insert([{
        driver_name: driverName.trim(),
        plate_number: plateNumber.trim().toUpperCase(),
        action_type: type,
        latitude:   pos.latitude,
        longitude:  pos.longitude,
        accuracy:   pos.accuracy ?? null,
        geo_lat:    currentGeofence.lat,
        geo_lng:    currentGeofence.lng,
        geo_radius: currentGeofence.radiusMeters,
        photo_url:  pub.publicUrl,
      }])

      if (error) {
        await supabase.storage.from('attendance-photos').remove([uploadedPath])
        const msg = error.message || ''
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

      setStatusMsg(`✅ Successfully clocked ${type.toUpperCase()}!`, 'ok')
      setDriverName('')
      setPlateNumber('')
      setVerifiedPosition(null)
    } catch (e) {
      console.error(e)
      setStatusMsg(`❌ Unexpected error: ${e.message}`, 'error')
    } finally {
      setIsLoading(false)
      setActiveType(null)
    }
  }

  return (
    <Shell>
      <Brand />

      <h1 className="nm-title">Driver Check-In</h1>
      <p className="nm-subtitle">Enter your details, then tap TIME IN or TIME OUT.</p>

      <div className="nm-form">
        <div className="nm-field">
          <div className="nm-field-body">
            <label htmlFor="nm-driver">Driver name</label>
            <input
              id="nm-driver"
              type="text"
              placeholder="Juan Dela Cruz"
              value={driverName}
              onChange={(e) => { setDriverName(e.target.value); setStatus('') }}
              disabled={isLoading}
              autoComplete="off"
            />
          </div>
        </div>

        <div className="nm-field">
          <div className="nm-field-body">
            <label htmlFor="nm-plate">Plate number</label>
            <input
              id="nm-plate"
              type="text"
              placeholder="ABC 1234"
              className="nm-upper"
              value={plateNumber}
              onChange={(e) => { setPlateNumber(e.target.value); setStatus('') }}
              disabled={isLoading}
              autoComplete="off"
              autoCapitalize="characters"
            />
          </div>
        </div>

        <div className="nm-actions">
          <button
            type="button"
            className="nm-btn in"
            onClick={() => handleCheck('in')}
            disabled={isLoading}
          >
            {isLoading && activeType === 'in' ? 'Checking location…' : 'TIME IN'}
          </button>
          <button
            type="button"
            className="nm-btn out"
            onClick={() => handleCheck('out')}
            disabled={isLoading}
          >
            {isLoading && activeType === 'out' ? 'Checking location…' : 'TIME OUT'}
          </button>
        </div>
      </div>

      <div aria-live="polite">
        {status && <p className={`nm-status ${statusType}`}>{status}</p>}
      </div>

      {pendingType && (
        <CameraCapture
          type={pendingType}
          onConfirm={(blob) => submitAttendance(pendingType, blob)}
          onCancel={() => setPendingType(null)}
        />
      )}

      <p className="nm-footer">NEMINTSCO · Driver attendance</p>
    </Shell>
  )
}

// --- ADMIN STATION (QR) ---
function AdminStation() {
  const scanUrl = window.location.origin + '/scan'

  return (
    <Shell>
      <Brand />

      <h1 className="nm-title">Admin Station</h1>
      <p className="nm-subtitle">Print this QR code and post it on the wall.</p>

      <div className="nm-qr">
        <QRCode value={scanUrl} size={200} style={{ width: '100%', height: 'auto' }} viewBox="0 0 200 200" />
      </div>
      <p className="nm-qr-hint">Drivers scan to check in</p>
      <p className="nm-url">{scanUrl}</p>

      <Link to="/admin" className="nm-btn link">
        <span>Go to Admin Login</span>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      </Link>

      <p className="nm-footer">NEMINTSCO · Admin access only</p>
    </Shell>
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
        <Route path="/admin" element={session ? <AdminDashboard /> : <Login />} />
        <Route path="/scan" element={<DriverScan />} />
        <Route path="/" element={<AdminStation />} />
      </Routes>
    </BrowserRouter>
  )
}

/* ---------- Styles (unchanged) ---------- */
const css = `
.nm-shell {
  --nm-text: #dce8f5;
  --nm-muted: #7f95ad;
  --nm-accent: #5ec8ff;
  --nm-lime: #b6ff4d;
  --nm-red: #ff5d5d;

  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-height: 100vh;
  min-height: 100dvh;
  padding:
    max(20px, env(safe-area-inset-top))
    max(16px, env(safe-area-inset-right))
    max(20px, env(safe-area-inset-bottom))
    max(16px, env(safe-area-inset-left));
  overflow: hidden;
  color: var(--nm-text);
  color-scheme: dark;
  text-align: left;
  background:
    radial-gradient(ellipse 70% 45% at 50% 0%, rgba(46, 130, 190, .38), transparent 70%),
    linear-gradient(180deg, #0f2740 0%, #0a1829 55%, #08111d 100%);
}
.nm-shell *,
.nm-shell *::before,
.nm-shell *::after { box-sizing: border-box; }

.nm-shell::before {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image: radial-gradient(rgba(255, 255, 255, .08) 1px, transparent 1px);
  background-size: 14px 14px;
  -webkit-mask-image: radial-gradient(ellipse at center, #000 25%, transparent 78%);
          mask-image: radial-gradient(ellipse at center, #000 25%, transparent 78%);
}

.nm-card {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  width: min(100%, 440px);
  padding: clamp(26px, 6vw, 40px) clamp(18px, 5vw, 32px) clamp(20px, 4vw, 28px);
  border-radius: clamp(24px, 6vw, 34px);
  border: 1px solid rgba(110, 190, 255, .25);
  background: linear-gradient(160deg, rgba(40, 92, 138, .38), rgba(16, 34, 58, .6));
  -webkit-backdrop-filter: blur(18px);
          backdrop-filter: blur(18px);
  box-shadow:
    0 30px 80px rgba(0, 0, 0, .45),
    inset 0 1px 0 rgba(255, 255, 255, .08);
}

.nm-card::before {
  content: '';
  position: absolute;
  top: -1px;
  left: 50%;
  width: 90px;
  height: 3px;
  transform: translateX(-50%);
  border-radius: 999px;
  background: var(--nm-accent);
  box-shadow: 0 0 28px 8px rgba(94, 200, 255, .55);
  filter: blur(1px);
}

.nm-card::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  background-image:
    radial-gradient(1px 1px at 18% 10%, rgba(255, 255, 255, .55), transparent 60%),
    radial-gradient(1px 1px at 34% 22%, rgba(255, 255, 255, .35), transparent 60%),
    radial-gradient(1.5px 1.5px at 62% 8%, rgba(255, 255, 255, .5), transparent 60%),
    radial-gradient(1px 1px at 78% 18%, rgba(255, 255, 255, .4), transparent 60%),
    radial-gradient(1px 1px at 88% 30%, rgba(255, 255, 255, .3), transparent 60%),
    radial-gradient(1px 1px at 8% 34%, rgba(255, 255, 255, .3), transparent 60%);
  -webkit-mask-image: linear-gradient(180deg, #000, transparent 45%);
          mask-image: linear-gradient(180deg, #000, transparent 45%);
}

.nm-brand {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}
.nm-logo {
  display: grid;
  place-items: center;
  width: 52px;
  height: 52px;
  border-radius: 16px;
  border: 1px solid rgba(120, 190, 255, .3);
  background: linear-gradient(160deg, #21486f, #132a44);
  box-shadow: 0 8px 24px rgba(0, 0, 0, .35), inset 0 1px 0 rgba(255, 255, 255, .12);
}
.nm-logo img { width: 30px; height: 30px; object-fit: contain; }
.nm-wordmark {
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 5px;
  padding-left: 5px;
  color: #9fd8ff;
  text-shadow: 0 0 18px rgba(94, 200, 255, .45);
}

.nm-title {
  margin: 0;
  text-align: center;
  font-size: clamp(26px, 6.5vw, 34px);
  font-weight: 500;
  letter-spacing: -.3px;
  color: #c3d3e6;
}
.nm-subtitle {
  margin: 8px 0 clamp(20px, 5vw, 28px);
  text-align: center;
  font-size: clamp(14px, 3.6vw, 16px);
  color: var(--nm-muted);
}

.nm-form { display: flex; flex-direction: column; gap: 12px; }

.nm-field {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-radius: 18px;
  border: 1px solid rgba(120, 160, 210, .16);
  background: rgba(20, 38, 62, .72);
  transition: border-color .15s, box-shadow .15s, background .15s;
}
.nm-field:focus-within {
  border-color: rgba(94, 200, 255, .6);
  background: rgba(24, 46, 74, .85);
  box-shadow: 0 0 0 3px rgba(94, 200, 255, .15);
}
.nm-field-body { flex: 1 1 auto; min-width: 0; }
.nm-field-body > label {
  display: block;
  font-size: 13px;
  color: var(--nm-muted);
  margin-bottom: 2px;
}
.nm-field input {
  display: block;
  width: 100%;
  min-width: 0;
  padding: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: #eaf3ff;
  font: inherit;
  font-size: 16px;
  line-height: 1.4;
}
.nm-field input::placeholder { color: rgba(127, 149, 173, .55); }
.nm-field input:disabled { opacity: .6; }
.nm-upper { text-transform: uppercase; }
.nm-upper::placeholder { text-transform: none; }

.nm-field input:-webkit-autofill {
  -webkit-text-fill-color: #eaf3ff;
  caret-color: #eaf3ff;
  box-shadow: 0 0 0 100px #14263e inset;
  transition: background-color 9999s;
}

.nm-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 6px; }

.nm-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 54px;
  padding: 0 16px;
  border: 0;
  border-radius: 16px;
  font: inherit;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: .5px;
  text-decoration: none;
  cursor: pointer;
  transition: filter .15s, transform .1s, opacity .15s;
}
.nm-btn:hover:not(:disabled) { filter: brightness(1.08); }
.nm-btn:active:not(:disabled) { transform: translateY(1px); }
.nm-btn:disabled { opacity: .6; cursor: not-allowed; }

.nm-actions .nm-btn { flex: 1 1 140px; }

.nm-btn.in {
  background: linear-gradient(180deg, #d2ff7a 0%, #7fd63a 100%);
  color: #10230a;
  box-shadow: 0 10px 26px rgba(127, 214, 58, .3), inset 0 1px 0 rgba(255, 255, 255, .5);
}
.nm-btn.out {
  background: linear-gradient(180deg, #ff9a9a 0%, #ef4a4a 100%);
  color: #2a0808;
  box-shadow: 0 10px 26px rgba(239, 74, 74, .3), inset 0 1px 0 rgba(255, 255, 255, .45);
}
.nm-btn.link {
  width: 100%;
  margin-top: 20px;
  background: linear-gradient(180deg, #7bd8ff 0%, #2f9bff 100%);
  color: #06223a;
  box-shadow: 0 10px 26px rgba(47, 155, 255, .35), inset 0 1px 0 rgba(255, 255, 255, .5);
}

.nm-status {
  margin: 18px 0 0;
  padding: 12px 14px;
  border-radius: 14px;
  border: 1px solid rgba(120, 160, 210, .25);
  background: rgba(20, 38, 62, .7);
  font-size: 14px;
  font-weight: 600;
  line-height: 1.45;
  text-align: center;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.nm-status.ok    { color: var(--nm-lime); border-color: rgba(182, 255, 77, .35); background: rgba(182, 255, 77, .08); }
.nm-status.error { color: #ffa3a3;        border-color: rgba(255, 93, 93, .35);  background: rgba(255, 93, 93, .1); }
.nm-status.info  { color: #8fd2ff;        border-color: rgba(94, 200, 255, .35); background: rgba(94, 200, 255, .08); }

.nm-note { margin: 10px 0 0; text-align: center; font-size: 12px; color: var(--nm-muted); }

.nm-qr {
  align-self: center;
  width: min(100%, 248px);
  padding: 16px;
  border-radius: 22px;
  background: #fff;
  box-shadow:
    0 0 0 6px rgba(94, 200, 255, .12),
    0 18px 40px rgba(0, 0, 0, .4);
}
.nm-qr svg { display: block; }
.nm-qr-hint {
  margin: 16px 0 0;
  text-align: center;
  font-size: 14px;
  font-weight: 600;
  color: #c3d3e6;
}
.nm-url {
  margin: 4px 0 0;
  text-align: center;
  font-size: 12px;
  color: var(--nm-muted);
  overflow-wrap: anywhere;
}

.nm-footer {
  margin: clamp(18px, 4vw, 26px) 0 0;
  text-align: center;
  font-size: 13px;
  color: var(--nm-muted);
}

.nm-cam-backdrop {
  position: fixed; inset: 0; z-index: 50;
  display: grid; place-items: center;
  padding: max(16px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom));
  background: rgba(4, 10, 18, .88);
  -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
}
.nm-cam {
  width: min(100%, 440px);
  display: flex; flex-direction: column; gap: 14px;
}
.nm-cam-title {
  margin: 0; text-align: center; font-size: 18px; font-weight: 600; color: #c3d3e6;
}
.nm-cam-frame {
  position: relative; width: 100%; aspect-ratio: 3 / 4;
  max-height: 68dvh;
  border-radius: 22px; overflow: hidden;
  background: #0a1829;
  border: 1px solid rgba(110, 190, 255, .3);
  display: grid; place-items: center;
}
.nm-cam-frame video, .nm-cam-frame img {
  width: 100%; height: 100%; object-fit: cover; display: block;
}
.nm-cam-frame video.mirror { transform: scaleX(-1); }
.nm-cam-error { padding: 20px; text-align: center; color: #ffa3a3; font-size: 14px; }
.nm-cam-actions { display: flex; gap: 10px; }
.nm-cam-actions .nm-btn { flex: 1; }
.nm-btn.ghost {
  background: rgba(255, 255, 255, .08); color: #dce8f5;
  border: 1px solid rgba(255, 255, 255, .15);
}
.nm-flip { flex: 0 0 54px !important; padding: 0; font-size: 20px; }
.nm-file-btn { cursor: pointer; }

.nm-shell :focus-visible { outline: 2px solid var(--nm-accent); outline-offset: 2px; }
.nm-field input:focus-visible { outline: none; }

@media (max-height: 700px) {
  .nm-shell { align-items: flex-start; overflow-y: auto; }
  .nm-card { margin: auto; }
}

@media (prefers-reduced-motion: reduce) {
  .nm-field, .nm-btn { transition: none; }
}
`