import { useState, useEffect, useMemo } from 'react'
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

export default function AdminDashboard() {
  const [logs, setLogs] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [menuOpen, setMenuOpen] = useState(false)
  const [busyId, setBusyId] = useState(null)   // row currently being deleted
  const [clearing, setClearing] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    fetchLogs()

    const channel = supabase
      .channel('realtime-attendance')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'attendance' }, (payload) => {
        setLogs((prev) => [payload.new, ...prev])
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'attendance' }, (payload) => {
        setLogs((prev) => prev.filter((l) => l.id !== payload.old.id))
      })
      .subscribe()

    return () => supabase.removeChannel(channel)
  }, [])

  const fetchLogs = async () => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    const { data } = await supabase
      .from('attendance')
      .select('*')
      .gte('created_at', today.toISOString())
      .order('created_at', { ascending: false })

    if (data) setLogs(data)
    setLoading(false)
  }

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

  const visibleLogs = useMemo(() => {
    const q = search.trim().toLowerCase()
    return logs.filter((l) => {
      const matchFilter = filter === 'all' || l.action_type === filter
      const matchSearch =
        !q ||
        l.driver_name?.toLowerCase().includes(q) ||
        l.plate_number?.toLowerCase().includes(q)
      return matchFilter && matchSearch
    })
  }, [logs, search, filter])

  // ---------- DELETE ONE ----------
  const handleDelete = async (id) => {
    if (!window.confirm('Delete this attendance record?')) return
    setBusyId(id)
    const { error } = await supabase.from('attendance').delete().eq('id', id)
    if (error) {
      alert('Failed to delete: ' + error.message)
    } else {
      setLogs((prev) => prev.filter((l) => l.id !== id))
    }
    setBusyId(null)
  }

  // ---------- CLEAR ALL TODAY ----------
  const handleClearAll = async () => {
    if (logs.length === 0) return
    if (!window.confirm(`Delete all ${logs.length} attendance record(s) from today? This cannot be undone.`)) return

    setClearing(true)
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    const { error } = await supabase
      .from('attendance')
      .delete()
      .gte('created_at', today.toISOString())

    if (error) {
      alert('Failed to clear: ' + error.message)
    } else {
      setLogs([])
    }
    setClearing(false)
  }

  // ---------- EXPORT CSV ----------
  const handleExport = () => {
    if (visibleLogs.length === 0) {
      alert('Nothing to export.')
      return
    }

    const headers = ['Driver', 'Plate Number', 'Action', 'Time', 'Date']
    const rows = visibleLogs.map((l) => {
      const d = new Date(l.created_at)
      return [
        l.driver_name ?? '',
        l.plate_number ?? '',
        l.action_type === 'in' ? 'TIME IN' : 'TIME OUT',
        d.toLocaleTimeString(),
        d.toLocaleDateString(),
      ]
    })

    const escape = (val) => `"${String(val).replace(/"/g, '""')}"`
    const csv = [headers, ...rows].map((r) => r.map(escape).join(',')).join('\r\n')

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
  }

  // Donut chart math
  const R = 70
  const C = 2 * Math.PI * R
  const inShare = stats.total ? stats.timeIn / stats.total : 0

  return (
    <div className="ad-shell">
      {/* ---------- Sidebar ---------- */}
      <aside className={`ad-sidebar ${menuOpen ? 'open' : ''}`}>
        <div className="ad-brand">
          <span className="ad-brand-mark">N</span>
          <span>NEMINTSCO</span>
        </div>

        <div className="ad-user">
          <div className="ad-avatar">AD</div>
          <span>Admin</span>
        </div>

        <p className="ad-nav-label">DASHBOARDS</p>
        <nav className="ad-nav">
          <button className="active">▦ Attendance</button>
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
          <button className="ad-burger" onClick={() => setMenuOpen((v) => !v)}>☰</button>
          <div className="ad-crumbs">
            <span>Dashboards</span> / <strong>Attendance</strong>
          </div>
          <div className="ad-live"><i /> Live</div>
        </header>

        <div className="ad-head">
          <h1>Overview</h1>
          <span className="ad-date">
            {new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
          </span>
        </div>

        {/* Stat cards */}
        <section className="ad-stats">
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

        <section className="ad-grid">
          {/* Donut */}
          <div className="ad-card ad-panel">
            <div className="ad-panel-head"><h3>Scan Overview</h3></div>
            <div className="ad-donut-wrap">
              <div className="ad-donut">
                <svg viewBox="0 0 180 180">
                  <circle cx="90" cy="90" r={R} className="ring-bg" />
                  <circle
                    cx="90" cy="90" r={R}
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
                <li><i className="lime" /> Time in <b>{stats.timeIn}</b></li>
                <li><i className="dim" /> Time out <b>{stats.timeOut}</b></li>
                <li><i className="mid" /> Clock-out rate <b>{stats.pct}%</b></li>
              </ul>
            </div>
          </div>

          {/* Recent activity */}
          <div className="ad-card ad-panel">
            <div className="ad-panel-head"><h3>Activities</h3></div>
            <ul className="ad-activity">
              {logs.slice(0, 5).map((l) => (
                <li key={l.id}>
                  <span className={`dot ${l.action_type}`} />
                  <div>
                    <p>{l.driver_name} {l.action_type === 'in' ? 'timed in' : 'timed out'}</p>
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
              />
              <div className="ad-pills">
                {['all', 'in', 'out'].map((f) => (
                  <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
                    {f === 'all' ? 'All' : f === 'in' ? 'Time in' : 'Time out'}
                  </button>
                ))}
              </div>

              {/* NEW: Export + Clear buttons */}
              <div className="ad-actions">
                <button
                  className="ad-btn export"
                  onClick={handleExport}
                  disabled={visibleLogs.length === 0}
                  title="Download current view as CSV"
                >
                  ⭳ Export CSV
                </button>
                <button
                  className="ad-btn danger"
                  onClick={handleClearAll}
                  disabled={clearing || logs.length === 0}
                  title="Delete all of today's attendance records"
                >
                  {clearing ? 'Clearing…' : '🗑 Clear all today'}
                </button>
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
                    <th>Driver</th>
                    <th>Plate number</th>
                    <th>Time</th>
                    <th>Action</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {visibleLogs.length === 0 ? (
                    <tr><td colSpan="5" className="ad-empty">No attendance records found.</td></tr>
                  ) : (
                    visibleLogs.map((log) => (
                      <tr key={log.id}>
                        <td>
                          <div className="ad-driver">
                            <span className="ad-avatar sm">{initials(log.driver_name)}</span>
                            {log.driver_name}
                          </div>
                        </td>
                        <td>{log.plate_number}</td>
                        <td>{new Date(log.created_at).toLocaleTimeString()}</td>
                        <td>
                          <span className={`ad-badge ${log.action_type}`}>
                            {log.action_type === 'in' ? 'TIME IN' : 'TIME OUT'}
                          </span>
                        </td>
                        <td>
                          <button
                            className="ad-row-delete"
                            onClick={() => handleDelete(log.id)}
                            disabled={busyId === log.id}
                            title="Delete this record"
                          >
                            {busyId === log.id ? '…' : '✕'}
                          </button>
                        </td>
                      </tr>
                    ))
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