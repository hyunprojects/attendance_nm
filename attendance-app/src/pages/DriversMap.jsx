import React, { useEffect, useMemo, useRef, useState } from 'react'
import { MapContainer, TileLayer, Marker, Popup, Circle, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

// "Online" = location update received within the last 2 minutes.
const ONLINE_MS = 2 * 60 * 1000
// Between 2 and 10 minutes = signal lost (phone locked / no data). After that = offline.
const RECENT_MS = 10 * 60 * 1000
// Rows older than this are hidden (driver probably forgot to clock out).
const HIDE_AFTER_MS = 12 * 60 * 60 * 1000

const STATUS_LABEL = { online: 'Online', recent: 'No signal', offline: 'Offline' }
const STATUS_ORDER = { online: 0, recent: 1, offline: 2 }

const esc = (s = '') =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const initials = (name = '') =>
  name.split(' ').filter(Boolean).slice(0, 2).map((n) => n[0]).join('').toUpperCase() || '?'

const haversine = (lat1, lon1, lat2, lon2) => {
  const R = 6371000
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

const ago = (ageMs) => {
  const s = Math.floor(ageMs / 1000)
  if (s < 10) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m ago`
}

const iconCache = new Map()
const pinIcon = (name, status, outside) => {
  const key = `${name}|${status}|${outside}`
  if (!iconCache.has(key)) {
    iconCache.set(
      key,
      L.divIcon({
        className: 'dm-pin-wrap',
        html: `<div class="dm-pin ${status}${outside ? ' outside' : ''}"><span>${esc(initials(name))}</span></div>`,
        iconSize: [38, 38],
        iconAnchor: [19, 19],
        popupAnchor: [0, -20],
      })
    )
  }
  return iconCache.get(key)
}

function MapController({ points, geofence, fit, focus }) {
  const map = useMap()

  useEffect(() => {
    if (fit.n === 0) return
    if (fit.type === 'geofence') {
      map.fitBounds(L.circle([geofence.lat, geofence.lng], { radius: geofence.radiusMeters }).getBounds(), {
        padding: [24, 24],
      })
    } else if (points.length === 1) {
      map.setView(points[0], 16)
    } else if (points.length > 1) {
      map.fitBounds(L.latLngBounds(points), { padding: [48, 48], maxZoom: 17 })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fit.n, map])

  useEffect(() => {
    if (focus) map.flyTo([focus.lat, focus.lng], 17, { duration: 0.8 })
  }, [focus, map])

  return null
}

export default function DriversMap({ locations = [], geofence, driverHours }) {
  const [now, setNow] = useState(() => Date.now())
  const [fit, setFit] = useState({ type: 'drivers', n: 0 })
  const [focus, setFocus] = useState(null)
  const [selected, setSelected] = useState(null)
  const didInitialFit = useRef(false)

  // Re-evaluate online/offline status every 15 seconds
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15000)
    return () => clearInterval(id)
  }, [])

  const drivers = useMemo(() => {
    return locations
      .map((l) => {
        const age = now - new Date(l.updated_at).getTime()
        const status = age < ONLINE_MS ? 'online' : age < RECENT_MS ? 'recent' : 'offline'
        const distance = Math.round(haversine(l.lat, l.lng, geofence.lat, geofence.lng))
        const outside = distance > geofence.radiusMeters
        const hours = driverHours?.get(l.driver_name)
        return {
          ...l,
          age,
          status,
          distance,
          outside,
          onDuty: hours ? hours.isOnDuty : null,
        }
      })
      .filter((d) => d.age < HIDE_AFTER_MS)
      .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.driver_name.localeCompare(b.driver_name))
  }, [locations, now, geofence, driverHours])

  const points = useMemo(() => drivers.map((d) => [d.lat, d.lng]), [drivers])

  // Fit the map once, the first time drivers show up
  useEffect(() => {
    if (!didInitialFit.current && drivers.length > 0) {
      didInitialFit.current = true
      setFit({ type: 'drivers', n: 1 })
    }
  }, [drivers.length])

  const counts = useMemo(() => {
    let online = 0, outside = 0, offline = 0
    for (const d of drivers) {
      if (d.status === 'offline') offline++
      else {
        if (d.status === 'online') online++
        if (d.outside) outside++
      }
    }
    return { online, outside, offline }
  }, [drivers])

  const pick = (d) => {
    setSelected(d.driver_name)
    setFocus({ lat: d.lat, lng: d.lng, n: Date.now() })
  }

  return (
    <div className="dm">
      <div className="dm-toolbar">
        <div className="dm-chips">
          <span className="dm-chip"><i className="online" /> {counts.online} online</span>
          <span className="dm-chip"><i className="outside" /> {counts.outside} outside geofence</span>
          <span className="dm-chip"><i className="offline" /> {counts.offline} offline</span>
        </div>
        <div className="dm-buttons">
          <button
            className="ad-btn"
            onClick={() => setFit((f) => ({ type: 'drivers', n: f.n + 1 }))}
            disabled={drivers.length === 0}
          >Fit drivers</button>
          <button className="ad-btn" onClick={() => setFit((f) => ({ type: 'geofence', n: f.n + 1 }))}>
            Geofence
          </button>
        </div>
      </div>

      <div className="dm-body">
        <div className="dm-map-wrap">
          <MapContainer
            center={[geofence.lat, geofence.lng]}
            zoom={15}
            scrollWheelZoom
            className="dm-map"
          >
            <TileLayer
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
              maxZoom={19}
            />
            <Circle
              center={[geofence.lat, geofence.lng]}
              radius={geofence.radiusMeters}
              pathOptions={{ color: '#8cc414', weight: 2, fillColor: '#a8e02e', fillOpacity: 0.12 }}
            />
            {drivers.map((d) => (
              <React.Fragment key={d.driver_name}>
                <Marker
                  position={[d.lat, d.lng]}
                  icon={pinIcon(d.driver_name, d.status, d.outside && d.status !== 'offline')}
                  zIndexOffset={d.status === 'online' ? 500 : 0}
                  eventHandlers={{ click: () => setSelected(d.driver_name) }}
                >
                  <Popup>
                    <div className="dm-popup">
                      <strong>{d.driver_name}</strong>
                      {d.plate_number && <div>{d.plate_number}</div>}
                      <div className={`dm-popup-status ${d.status}`}>
                        {STATUS_LABEL[d.status]} · {ago(d.age)}
                      </div>
                      <div>
                        {d.outside ? `${d.distance} m outside geofence` : 'Inside geofence'}
                      </div>
                      {d.speed != null && d.speed > 0 && (
                        <div>{Math.round(d.speed * 3.6)} km/h</div>
                      )}
                      <a
                        href={`https://www.google.com/maps?q=${d.lat},${d.lng}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >Open in Google Maps</a>
                    </div>
                  </Popup>
                </Marker>
              </React.Fragment>
            ))}
            <MapController points={points} geofence={geofence} fit={fit} focus={focus} />
          </MapContainer>

          {drivers.length === 0 && (
            <div className="dm-empty">
              <strong>No live locations yet</strong>
              <span>Drivers appear here after they clock in and allow location access on the driver app.</span>
            </div>
          )}
        </div>

        <ul className="dm-list" aria-label="Drivers on the map">
          {drivers.map((d) => (
            <li key={d.driver_name}>
              <button
                className={`dm-row ${selected === d.driver_name ? 'sel' : ''}`}
                onClick={() => pick(d)}
              >
                <span className={`dm-dot ${d.status}`} aria-hidden="true" />
                <span className="dm-row-main">
                  <span className="dm-row-name">{d.driver_name}</span>
                  <span className="dm-row-sub">
                    {STATUS_LABEL[d.status]} · {ago(d.age)}
                    {d.plate_number ? ` · ${d.plate_number}` : ''}
                  </span>
                </span>
                {d.status !== 'offline' && (
                  <span className={`dm-tag ${d.outside ? 'outside' : 'inside'}`}>
                    {d.outside ? `${d.distance} m out` : 'Inside'}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}