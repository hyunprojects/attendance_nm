import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { supabase } from '../supabaseClient'
import { useNavigate } from 'react-router-dom'
import './AdminDashboard.css'

const initials = (name = '') =>
  name.split(' ').filter(Boolean).slice(0, 2).map((n) => n[0]).join('').toUpperCase() || '?'

const timeAgo = (iso) => {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins} min${mins > 1 ? 's' : ''} ago`
  const hrs = Math.floor(mins / 60)
  return `${hrs} hour${hrs > 1 ? 's' : ''} ago`
}

// ---------- HOURS TRACKING ----------
const DAILY_TARGET_HOURS = 8

const formatHours = (hours) => {
  if (hours === null || hours === undefined || isNaN(hours)) return '—'
  const totalMins = Math.max(0, Math.round(hours * 60))
  const h = Math.floor(totalMins / 60)
  const m = totalMins % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

/**
 * Pair TIME IN / TIME OUT events per driver and compute worked / remaining hours.
 * Also flags anomalies:
 *  - double-in (in while already in)
 *  - stray-out (out with no matching in)
 */
const computeDriverHours = (logs) => {
  const now = Date.now()

  const byDriver = new Map()
  for (const log of logs) {
    const key = log.driver_name || 'Unknown'
    if (!byDriver.has(key)) byDriver.set(key, [])
    byDriver.get(key).push(log)
  }

  const result = new Map()
  const anomalies = new Set()

  for (const [driver, entries] of byDriver) {
    const sorted = [...entries].sort(
      (a, b) => new Date(a.created_at) - new Date(b.created_at)
    )

    let workedMs = 0
    let openIn = null
    let openInId = null

    for (const e of sorted) {
      const t = new Date(e.created_at).getTime()

      if (e.action_type === 'in') {
        if (openIn !== null) {
          anomalies.add(e.id)
          continue
        }
        openIn = t
        openInId = e.id
      } else if (e.action_type === 'out') {
        if (openIn === null) {
          anomalies.add(e.id)
          continue
        }
        workedMs += Math.max(0, t - openIn)
        openIn = null
        openInId = null
      }
    }

    const isOnDuty = openIn !== null
    if (isOnDuty) workedMs += Math.max(0, now - openIn)

    const workedHours = workedMs / 3_600_000
    const remainingHours = Math.max(0, DAILY_TARGET_HOURS - workedHours)
    const overtimeHours = Math.max(0, workedHours - DAILY_TARGET_HOURS)

    result.set(driver, {
      workedHours,
      remainingHours,
      overtimeHours,
      isOnDuty,
      clockedInAt: openIn,
      clockedInId: openInId,
      plate: sorted[0]?.plate_number ?? '',
    })
  }

  return { driverHours: result, anomalies }
}

// Only this account can delete records
const ADMIN_EMAIL = 'elendaday@gmail.com'

// Geofence: warehouse / base location. Adjust to your real coords.
const GEOFENCE = {
  lat: 14.5995,
  lng: 120.9842,
  radiusMeters: 300,
}

// Haversine distance in meters
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

const isInsideGeofence = (lat, lng) => {
  if (lat == null || lng == null) return null
  return haversine(lat, lng, GEOFENCE.lat, GEOFENCE.lng) <= GEOFENCE.radiusMeters
}

const mapsLink = (lat, lng) =>
  lat != null && lng != null
    ? `https://www.google.com/maps?q=${lat},${lng}`
    : null

// ---------- TOAST HOOK ----------
function useToasts() {
  const [toasts, setToasts] = useState([])
  const idRef = useRef(0)

  const dismiss = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const push = useCallback(
    (message, type = 'info', duration = 3500) => {
      const id = ++idRef.current
      setToasts((prev) => [...prev, { id, message, type }])
      if (duration > 0) {
        setTimeout(() => dismiss(id), duration)
      }
      return id
    },
    [dismiss]
  )

  return { toasts, push, dismiss }
}

export default function AdminDashboard() {
  const [logs, setLogs] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [menuOpen, setMenuOpen] = useState(false)
  const [busyId, setBusyId] = useState(null)
  const [clearing, setClearing] = useState(false)
  const [currentUserEmail, setCurrentUserEmail] = useState(null)
  const [tick, setTick] = useState(0)
  const navigate = useNavigate()

  const { toasts, push: toast, dismiss: dismissToast } = useToasts()

  const sidebarRef = useRef(null)
  const burgerRef = useRef(null)

  // Auth guard
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) navigate('/')
    })
  }, [navigate])

  // Current user email (for delete permissions)
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data?.user) setCurrentUserEmail(data.user.email)
    })
  }, [])

  const canDelete = currentUserEmail === ADMIN_EMAIL

  // Re-render every 30s so "remaining hours" ticks down live
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30000)
    return () => clearInterval(id)
  }, [])

  const fetchLogs = useCallback(async () => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    const { data, error } = await supabase
      .from('attendance')
      .select('*')
      .gte('created_at', today.toISOString())
      .order('created_at', { ascending: false })

    if (error) {
      console.error('Failed to fetch logs:', error.message)
      toast('Failed to load attendance logs.', 'error')
    } else if (data) {
      setLogs(data)
    }
    setLoading(false)
  }, [toast])

  useEffect(() => {
    fetchLogs()

    const channel = supabase
      .channel('realtime-attendance')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'attendance' },
        (payload) => {
          setLogs((prev) => {
            if (prev.some((l) => l.id === payload.new.id)) return prev
            toast(
              `${payload.new.driver_name} ${
                payload.new.action_type === 'in' ? 'timed in' : 'timed out'
              }`,
              payload.new.action_type === 'in' ? 'success' : 'info'
            )
            return [payload.new, ...prev]
          })
        }
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'attendance' },
        (payload) => {
          setLogs((prev) => prev.filter((l) => l.id !== payload.old.id))
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [fetchLogs, toast])

  // ---------- MOBILE MENU: scroll lock + auto-close on desktop ----------
  useEffect(() => {
    document.body.style.overflow = menuOpen ? 'hidden' : ''
    return () => {
      document.body.style.overflow = ''
    }
  }, [menuOpen])

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 761px)')
    const onChange = (e) => {
      if (e.matches) setMenuOpen(false)
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  // ---------- KEYBOARD ACCESSIBILITY ----------
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && menuOpen) {
        setMenuOpen(false)
        burgerRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menuOpen])

  // Focus trap for the mobile sidebar
  useEffect(() => {
    if (!menuOpen) return
    const node = sidebarRef.current
    if (!node) return

    const focusable = node.querySelectorAll(
      'button:not(:disabled), [href], input, [tabindex]:not([tabindex="-1"])'
    )
    const first = focusable[0]
    const last = focusable[focusable.length - 1]

    const trap = (e) => {
      if (e.key !== 'Tab') return
      if (focusable.length === 0) {
        e.preventDefault()
        return
      }
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }

    node.addEventListener('keydown', trap)
    first?.focus()

    return () => node.removeEventListener('keydown', trap)
  }, [menuOpen])

  const handleLogout = async () => {
    await supabase.auth.signOut()
    navigate('/')
  }

  const stats = useMemo(() => {
    const timeIn = logs.filter((l) => l.action_type === 'in').length
    const timeOut = logs.filter((l) => l.action_type === 'out').length
    const drivers = new Set(logs.map((l) => l.driver_name)).size
    const onDuty = Math.max(timeIn - timeOut, 0)
    const pct = timeIn ? Math.round((timeOut / timeIn) * 100) : 0
    return { total: logs.length, timeIn, timeOut, drivers, onDuty, pct }
  }, [logs])

  const { driverHours, anomalies } = useMemo(
    () => computeDriverHours(logs),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [logs, tick]
  )

  const visibleLogs = useMemo(() => {
    const q = search.trim().toLowerCase()
    return logs.filter((l) => {
      let matchFilter = true
      if (filter === 'in' || filter === 'out') {
        matchFilter = l.action_type === filter
      } else if (filter === 'overtime') {
        // Check if this driver has overtime hours
        const h = driverHours.get(l.driver_name)
        matchFilter = h ? h.overtimeHours > 0 : false
      }

      const matchSearch =
        !q ||
        l.driver_name?.toLowerCase().includes(q) ||
        l.plate_number?.toLowerCase().includes(q)
      return matchFilter && matchSearch
    })
  }, [logs, search, filter, driverHours])

  const hoursSummary = useMemo(() => {
    let completed = 0
    let overtime = 0
    let onDuty = 0
    let totalRemaining = 0
    for (const [, h] of driverHours) {
      if (h.overtimeHours > 0) overtime++
      else if (h.remainingHours <= 0) completed++
      if (h.isOnDuty) onDuty++
      totalRemaining += h.remainingHours
    }
    return { completed, overtime, onDuty, totalRemaining }
  }, [driverHours])

  const geoSummary = useMemo(() => {
    let inside = 0
    let outside = 0
    let unknown = 0
    for (const l of logs) {
      const insideGeo = isInsideGeofence(l.latitude, l.longitude)
      if (insideGeo === true) inside++
      else if (insideGeo === false) outside++
      else unknown++
    }
    return { inside, outside, unknown }
  }, [logs])

  // ---------- DELETE ONE ----------
  const handleDelete = async (id) => {
    if (!canDelete) return
    if (!window.confirm('Delete this attendance record?')) return
    setBusyId(id)
    const { error } = await supabase.from('attendance').delete().eq('id', id)
    if (error) {
      toast('Failed to delete: ' + error.message, 'error')
    } else {
      setLogs((prev) => prev.filter((l) => l.id !== id))
      toast('Record deleted.', 'success')
    }
    setBusyId(null)
  }

  // ---------- CLEAR ALL TODAY ----------
  const handleClearAll = async () => {
    if (!canDelete) return
    if (logs.length === 0) return
    if (
      !window.confirm(
        `Delete all ${logs.length} attendance record(s) from today? This cannot be undone.`
      )
    )
      return

    setClearing(true)
    const ids = logs.map((l) => l.id)
    const { error } = await supabase.from('attendance').delete().in('id', ids)

    if (error) {
      toast('Failed to clear: ' + error.message, 'error')
    } else {
      setLogs([])
      toast(`Cleared ${ids.length} record(s).`, 'success')
    }
    setClearing(false)
  }

  // ---------- EXPORT CSV ----------
  const handleExport = () => {
    if (visibleLogs.length === 0) {
      toast('Nothing to export.', 'info')
      return
    }

    const headers = [
      'Driver',
      'Plate Number',
      'Action',
      'Time',
      'Date',
      'Worked Hours',
      'Remaining Hours',
      'Latitude',
      'Longitude',
      'Location Status',
      'Anomaly',
    ]
    const rows = visibleLogs.map((l) => {
      const d = new Date(l.created_at)
      const h = driverHours.get(l.driver_name)
      const inside = isInsideGeofence(l.latitude, l.longitude)
      return [
        l.driver_name ?? '',
        l.plate_number ?? '',
        l.action_type === 'in' ? 'TIME IN' : 'TIME OUT',
        d.toLocaleTimeString(),
        d.toLocaleDateString(),
        h ? formatHours(h.workedHours) : '',
        h ? formatHours(h.remainingHours) : '',
        l.latitude ?? '',
        l.longitude ?? '',
        inside === null ? 'Unknown' : inside ? 'Inside geofence' : 'Outside geofence',
        anomalies.has(l.id) ? 'Duplicate / out-of-order' : '',
      ]
    })

    const escape = (val) => `"${String(val).replace(/"/g, '""')}"`
    const csv = [headers, ...rows]
      .map((r) => r.map(escape).join(','))
      .join('\r\n')

    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const stamp = new Date().toISOString().slice(0, 10)
    a.href = url
    a.download = `attendance-${stamp}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    toast(`Exported ${rows.length} row(s).`, 'success')
  }

  // Donut chart math
  const R = 70
  const C = 2 * Math.PI * R
  const inShare = stats.total ? stats.timeIn / stats.total : 0

  const renderHoursCell = (driverName) => {
    const h = driverHours.get(driverName)
    if (!h) return <span className="ad-hours-muted">—</span>

    if (h.overtimeHours > 0) {
      return (
        <span className="ad-hours-badge overtime" title={`Worked ${formatHours(h.workedHours)}`}>
          +{formatHours(h.overtimeHours)} OT
        </span>
      )
    }
    if (h.remainingHours <= 0) {
      return (
        <span className="ad-hours-badge done" title={`Worked ${formatHours(h.workedHours)}`}>
          Complete
        </span>
      )
    }
    return (
      <span
        className={`ad-hours-badge ${h.isOnDuty ? 'active' : 'idle'}`}
        title={`Worked ${formatHours(h.workedHours)}`}
      >
        {formatHours(h.remainingHours)} left
      </span>
    )
  }

  const renderLocationCell = (log) => {
    const inside = isInsideGeofence(log.latitude, log.longitude)
    const link = mapsLink(log.latitude, log.longitude)

    if (inside === null) {
      return <span className="ad-geo-muted" title="No GPS data captured">No GPS</span>
    }

    const cls = inside ? 'inside' : 'outside'
    const label = inside ? 'Inside' : 'Outside'
    const tip = inside
      ? 'Within geofence'
      : `Outside geofence (${Math.round(
          haversine(log.latitude, log.longitude, GEOFENCE.lat, GEOFENCE.lng)
        )}m away)`

    return (
      <a
        className={`ad-geo-pill ${cls}`}
        href={link}
        target="_blank"
        rel="noopener noreferrer"
        title={tip}
        aria-label={`${label} geofence — open location in Google Maps`}
      >
        <i aria-hidden="true" /> {label}
      </a>
    )
  }

  const closeMenu = () => setMenuOpen(false)

  return (
    <div className="ad-shell">
      {/* ---------- Toasts ---------- */}
      <div className="ad-toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`ad-toast ${t.type}`}>
            <span>{t.message}</span>
            <button
              className="ad-toast-close"
              onClick={() => dismissToast(t.id)}
              aria-label="Dismiss notification"
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      {/* ---------- Backdrop (mobile only) ---------- */}
      <div
        className={`ad-backdrop ${menuOpen ? 'show' : ''}`}
        onClick={closeMenu}
        aria-hidden="true"
      />

      {/* ---------- Sidebar ---------- */}
      <aside
        id="ad-sidebar"
        ref={sidebarRef}
        className={`ad-sidebar ${menuOpen ? 'open' : ''}`}
        aria-label="Main navigation"
      >
        <div className="ad-brand">
          <span className="ad-brand-mark" aria-hidden="true">N</span>
          <span>NEMINTSCO</span>
        </div>

        <div className="ad-user">
          <div className="ad-avatar" aria-hidden="true">AD</div>
          <span>Admin</span>
        </div>

        <p className="ad-nav-label">DASHBOARDS</p>
        <nav className="ad-nav">
          <button className="active" aria-current="page" onClick={closeMenu}>▦ Attendance</button>
          <button disabled>₱ Revenue</button>
          <button disabled>🚕 Drivers</button>
        </nav>

        <p className="ad-nav-label">SETTINGS</p>
        <nav className="ad-nav">
          <button disabled>⚙ Settings</button>
          <button onClick={handleLogout}>⎋ Logout</button>
        </nav>
      </aside>

      {/* ---------- Main ---------- */}
      <main className="ad-main">
        <header className="ad-topbar">
          <button
            ref={burgerRef}
            className="ad-burger"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label={menuOpen ? 'Close navigation menu' : 'Open navigation menu'}
            aria-expanded={menuOpen}
            aria-controls="ad-sidebar"
          >
            ☰
          </button>
          <div className="ad-crumbs">
            <span>Dashboards</span> / <strong>Attendance</strong>
          </div>
          <div className="ad-live" aria-label="Live data">
            <i aria-hidden="true" /> Live
          </div>
        </header>

        <div className="ad-head">
          <h1>Overview</h1>
          <span className="ad-date">
            {new Date().toLocaleDateString(undefined, {
              weekday: 'long',
              month: 'long',
              day: 'numeric',
            })}
          </span>
        </div>

        {/* Stat cards */}
        <section className="ad-stats" aria-label="Attendance summary">
          <div className="ad-card">
            <p>Total scans</p>
            <h2>{stats.total}</h2>
            <small className="up">↗ today</small>
          </div>
          <div className="ad-card">
            <p>Time in</p>
            <h2>{stats.timeIn}</h2>
            <small className="up">↗ drivers clocked in</small>
          </div>
          <div className="ad-card">
            <p>Time out</p>
            <h2>{stats.timeOut}</h2>
            <small className="down">↘ drivers clocked out</small>
          </div>
          <div className="ad-card">
            <p>Currently on duty</p>
            <h2>{stats.onDuty}</h2>
            <small>{stats.drivers} unique drivers</small>
          </div>
        </section>

        {/* Hours overview strip */}
        <section className="ad-hours-strip" aria-label="Hours at a glance">
          <div className="ad-hours-chip">
            <span className="label">Target / day</span>
            <strong>8h</strong>
          </div>
          <div className="ad-hours-chip">
            <span className="label">On duty</span>
            <strong className="lime">{hoursSummary.onDuty}</strong>
          </div>
          <div className="ad-hours-chip">
            <span className="label">Completed 8h</span>
            <strong className="lime">{hoursSummary.completed}</strong>
          </div>
          <div className="ad-hours-chip">
            <span className="label">Overtime</span>
            <strong className="red">{hoursSummary.overtime}</strong>
          </div>
          <div className="ad-hours-chip">
            <span className="label">Total remaining</span>
            <strong>{formatHours(hoursSummary.totalRemaining)}</strong>
          </div>
        </section>

        {/* Geo overview strip */}
        <section className="ad-hours-strip" aria-label="Geofence summary">
          <div className="ad-hours-chip">
            <span className="label">Inside geofence</span>
            <strong className="lime">{geoSummary.inside}</strong>
          </div>
          <div className="ad-hours-chip">
            <span className="label">Outside geofence</span>
            <strong className="red">{geoSummary.outside}</strong>
          </div>
          <div className="ad-hours-chip">
            <span className="label">No GPS data</span>
            <strong>{geoSummary.unknown}</strong>
          </div>
          <div className="ad-hours-chip">
            <span className="label">Anomalies</span>
            <strong className="red">{anomalies.size}</strong>
          </div>
        </section>

        <section className="ad-grid">
          {/* Donut */}
          <div className="ad-card ad-panel ad-panel-donut">
            <div className="ad-panel-head">
              <h3>Scan Overview</h3>
            </div>
            <div className="ad-donut-wrap">
              <div className="ad-donut">
                <svg viewBox="0 0 180 180" role="img" aria-label="Scans split by type">
                  <circle cx="90" cy="90" r={R} className="ring-bg" />
                  <circle
                    cx="90"
                    cy="90"
                    r={R}
                    className="ring-fg"
                    strokeDasharray={`${C * inShare} ${C}`}
                    transform="rotate(-90 90 90)"
                  />
                </svg>
                <div className="ad-donut-label">
                  <strong>{stats.total}</strong>
                  <span>Scans today</span>
                </div>
              </div>
              <ul className="ad-legend">
                <li><i className="lime" aria-hidden="true" /> Time in <b>{stats.timeIn}</b></li>
                <li><i className="dim" aria-hidden="true" /> Time out <b>{stats.timeOut}</b></li>
                <li><i className="mid" aria-hidden="true" /> Clock-out rate <b>{stats.pct}%</b></li>
              </ul>
            </div>
          </div>

          {/* Recent activity */}
          <div className="ad-card ad-panel ad-panel-activity">
            <div className="ad-panel-head">
              <h3>Activities</h3>
            </div>
            <ul className="ad-activity">
              {logs.slice(0, 5).map((l) => (
                <li key={l.id}>
                  <span className={`dot ${l.action_type}`} aria-hidden="true" />
                  <div>
                    <p>
                      {l.driver_name} {l.action_type === 'in' ? 'timed in' : 'timed out'}
                    </p>
                    <small>{timeAgo(l.created_at)}</small>
                  </div>
                </li>
              ))}
              {logs.length === 0 && <li className="empty">No activity yet</li>}
            </ul>
          </div>
        </section>

        {/* Table */}
        <section className="ad-card ad-panel ad-table-card">
          <div className="ad-panel-head">
            <h3>Attendance log</h3>
            <div className="ad-tools">
              <input
                type="search"
                placeholder="Search driver or plate…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search driver or plate"
              />
              <div className="ad-pills" role="group" aria-label="Filter by action">
                {['all', 'in', 'out', 'overtime'].map((f) => (
                  <button
                    key={f}
                    className={filter === f ? 'active' : ''}
                    onClick={() => setFilter(f)}
                    aria-pressed={filter === f}
                  >
                    {f === 'all' ? 'All' : f === 'in' ? 'Time in' : f === 'out' ? 'Time out' : 'Overtime'}
                  </button>
                ))}
              </div>

              <div className="ad-actions">
                <button
                  className="ad-btn export"
                  onClick={handleExport}
                  disabled={visibleLogs.length === 0}
                  title="Download current view as CSV"
                >
                  ⭳ Export CSV
                </button>
                {canDelete && (
                  <button
                    className="ad-btn danger"
                    onClick={handleClearAll}
                    disabled={clearing || logs.length === 0}
                    title="Delete all of today's attendance records"
                  >
                    {clearing ? 'Clearing…' : '🗑 Clear all today'}
                  </button>
                )}
              </div>
            </div>
          </div>

          {loading ? (
            <p className="ad-empty">Loading…</p>
          ) : (
            <div className="ad-table-scroll">
              <table className="ad-table">
                <thead>
                  <tr>
                    <th scope="col">Driver</th>
                    <th scope="col">Plate number</th>
                    <th scope="col">Time</th>
                    <th scope="col">Action</th>
                    <th scope="col">Location</th>
                    <th scope="col">Worked</th>
                    <th scope="col">Hours left</th>
                    <th scope="col"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {visibleLogs.length === 0 ? (
                    <tr>
                      <td colSpan="8" className="ad-empty cell-empty">
                        No {filter !== 'all' ? `${filter} ` : ''}attendance records found.
                      </td>
                    </tr>
                  ) : (
                    visibleLogs.map((log) => {
                      const h = driverHours.get(log.driver_name)
                      const isAnomaly = anomalies.has(log.id)
                      return (
                        <tr key={log.id} className={isAnomaly ? 'ad-row-anomaly' : ''}>
                          <td className="cell-driver">
                            <div className="ad-driver">
                              <span className="ad-avatar sm" aria-hidden="true">
                                {initials(log.driver_name)}
                              </span>
                              <span className="ad-driver-name">{log.driver_name}</span>
                              {isAnomaly && (
                                <span
                                  className="ad-anomaly-badge"
                                  title="Duplicate or out-of-order scan — this entry was ignored for hours calculation"
                                  aria-label="Anomaly: duplicate or out-of-order scan"
                                >
                                  ⚠
                                </span>
                              )}
                            </div>
                          </td>
                          <td data-label="Plate">{log.plate_number}</td>
                          <td data-label="Time">
                            {new Date(log.created_at).toLocaleTimeString()}
                          </td>
                          <td data-label="Action">
                            <span className={`ad-badge ${log.action_type}`}>
                              {log.action_type === 'in' ? 'TIME IN' : 'TIME OUT'}
                            </span>
                          </td>
                          <td data-label="Location">{renderLocationCell(log)}</td>
                          <td data-label="Worked">
                            {h ? (
                              <span className="ad-worked" title="Total worked today">
                                {formatHours(h.workedHours)}
                                {h.isOnDuty && (
                                  <span
                                    className="ad-live-dot"
                                    title="Currently on duty"
                                    aria-label="Currently on duty"
                                  />
                                )}
                              </span>
                            ) : (
                              <span className="ad-hours-muted">—</span>
                            )}
                          </td>
                          <td data-label="Hours left">{renderHoursCell(log.driver_name)}</td>
                          <td className="cell-actions">
                            {canDelete ? (
                              <button
                                className="ad-row-delete"
                                onClick={() => handleDelete(log.id)}
                                disabled={busyId === log.id}
                                aria-label={`Delete attendance record for ${log.driver_name}`}
                                title="Delete this record"
                              >
                                {busyId === log.id ? '…' : '✕'}
                              </button>
                            ) : null}
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </div>
  )
}