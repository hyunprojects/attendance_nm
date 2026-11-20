import { useEffect, useRef } from 'react'
import { supabase } from '../supabaseClient'

/**
 * Streams the driver's GPS position to `driver_locations` while `active` is true.
 *
 * Usage in your driver time-in page:
 *
 *   const [onDuty, setOnDuty] = useState(false)   // true after TIME IN, false after TIME OUT
 *   useDriverTracking({
 *     driverName: driver.name,
 *     plateNumber: plate,
 *     active: onDuty,
 *     onError: (e) => console.warn('Tracking:', e.message),
 *   })
 *
 * Tip: on page load, set onDuty from the driver's latest attendance row
 * (action_type === 'in' today) so tracking resumes after a refresh.
 *
 * Limitation: browsers pause GPS when the screen locks or the tab is in the
 * background. The driver must keep the page open (we request a screen wake lock
 * to help). For true background tracking you need a native app.
 */
export default function useDriverTracking({
  driverName,
  plateNumber,
  active,
  intervalMs = 15000,
  onError,
}) {
  const latestPos = useRef(null)
  const wasActive = useRef(false)

  // ---- stream while active ----
  useEffect(() => {
    if (!active || !driverName) return
    if (!('geolocation' in navigator)) {
      onError?.(new Error('Geolocation is not supported on this device.'))
      return
    }

    let stopped = false
    let wakeLock = null

    const send = async () => {
      const pos = latestPos.current
      if (!pos || stopped) return
      const { error } = await supabase.from('driver_locations').upsert(
        {
          driver_name: driverName,
          plate_number: plateNumber ?? null,
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy ?? null,
          speed: pos.coords.speed ?? null,
          heading: pos.coords.heading ?? null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'driver_name' }
      )
      if (error) onError?.(error)
    }

    let firstFix = true
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        latestPos.current = pos
        if (firstFix) { firstFix = false; send() } // show on the map right away
      },
      (err) => onError?.(err),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
    )

    // Heartbeat: watchPosition only fires when the position changes, so a driver
    // parked at a stop would look "offline". This resends the latest fix.
    const timer = setInterval(send, intervalMs)

    // Keep the screen on so the browser keeps delivering GPS updates.
    const requestWakeLock = async () => {
      try {
        if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen')
      } catch { /* not supported or denied — ignore */ }
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        requestWakeLock()
        send()
      }
    }
    requestWakeLock()
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      stopped = true
      navigator.geolocation.clearWatch(watchId)
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      wakeLock?.release?.().catch(() => {})
      latestPos.current = null
    }
  }, [active, driverName, plateNumber, intervalMs, onError])

  // ---- remove the live row when the driver clocks out ----
  useEffect(() => {
    if (wasActive.current && !active && driverName) {
      supabase.from('driver_locations').delete().eq('driver_name', driverName).then(() => {})
    }
    wasActive.current = active
  }, [active, driverName])
}