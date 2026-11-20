import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { supabase } from '../supabaseClient'
import { useNavigate } from 'react-router-dom'
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
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

// ---------- DATE HELPERS ----------
const dayBounds = (dateStr) => {
  const [y, m, d] = dateStr.split('-').map(Number)
  const start = new Date(y, m - 1, d, 0, 0, 0, 0)
  const end = new Date(y, m - 1, d + 1, 0, 0, 0, 0)
  return { start: start.toISOString(), end: end.toISOString() }
}

const toDateInput = (d = new Date()) => {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

const isSameDay = (iso, dateStr) => {
  const { start, end } = dayBounds(dateStr)
  const t = new Date(iso).getTime()
  return t >= new Date(start).getTime() && t < new Date(end).getTime()
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

const computeDriverHours = (logs, { liveOpenSession = true } = {}) => {
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
    let openInLog = null

    for (const e of sorted) {
      const t = new Date(e.created_at).getTime()
      if (e.action_type === 'in') {
        if (openIn !== null) { anomalies.add(e.id); continue }
        openIn = t
        openInId = e.id
        openInLog = e
      } else if (e.action_type === 'out') {
        if (openIn === null) { anomalies.add(e.id); continue }
        workedMs += Math.max(0, t - openIn)
        openIn = null
        openInId = null
        openInLog = null
      }
    }

    const hasOpenSession = openIn !== null
    const isOnDuty = hasOpenSession && liveOpenSession
    if (isOnDuty) workedMs += Math.max(0, now - openIn)
    if (hasOpenSession && !liveOpenSession) anomalies.add(openInId)

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
      clockedInLog: openInLog,
      plate: sorted[0]?.plate_number ?? '',
    })
  }
  return { driverHours: result, anomalies }
}

const ADMIN_EMAIL = 'elendaday@gmail.com'

// Geofence fallback
const DEFAULT_GEOFENCE = { lat: 14.5995, lng: 120.9842, radiusMeters: 300 }

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

const resolveGeofenceFor = (log, geofence) => {
  if (log?.geo_lat != null && log?.geo_lng != null && log?.geo_radius != null) {
    return { lat: log.geo_lat, lng: log.geo_lng, radiusMeters: log.geo_radius }
  }
  return geofence
}

const isInsideGeofence = (lat, lng, geo) => {
  if (lat == null || lng == null || !geo) return null
  return haversine(lat, lng, geo.lat, geo.lng) <= geo.radiusMeters
}

const mapsLink = (lat, lng) =>
  lat != null && lng != null ? `https://www.google.com/maps?q=${lat},${lng}` : null

// ---------- CSV HELPERS ----------
const CSV_HEADERS = [
  'Driver','Plate Number','Action','Time','Date','Worked Hours','Remaining Hours',
  'Latitude','Longitude','Location Status','Auto-closed','Anomaly','Photo URL',
]

const escapeCsv = (val) => `"${String(val).replace(/"/g, '""')}"`

const downloadCsv = (rows, filename) => {
  const csv = [CSV_HEADERS, ...rows].map((r) => r.map(escapeCsv).join(',')).join('\r\n')
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a); a.click(); document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// ---------- PDF HELPERS ----------
const loadImageAsDataUrl = async (url) => {
  try {
    const res = await fetch(url, { mode: 'cors' })
    if (!res.ok) return null
    const blob = await res.blob()
    return await new Promise((resolve) => {
      const reader = new FileReader()
      reader.onloadend = () => resolve(reader.result)
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}

const guessImageFormat = (dataUrl) => {
  if (!dataUrl) return 'JPEG'
  if (dataUrl.startsWith('data:image/png')) return 'PNG'
  if (dataUrl.startsWith('data:image/webp')) return 'WEBP'
  return 'JPEG'
}

const formatTime = (iso) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

const formatDate = (iso) =>
  new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

// ---------- TOAST ----------
function useToasts() {
  const [toasts, setToasts] = useState([])
  const idRef = useRef(0)
  const dismiss = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])
  const push = useCallback((message, type = 'info', duration = 3500) => {
    const id = ++idRef.current
    setToasts((prev) => [...prev, { id, message, type }])
    if (duration > 0) setTimeout(() => dismiss(id), duration)
    return id
  }, [dismiss])
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
  const [geofence, setGeofence] = useState(DEFAULT_GEOFENCE)
  const [geoEditorOpen, setGeoEditorOpen] = useState(false)
  const [geoDraft, setGeoDraft] = useState(DEFAULT_GEOFENCE)
  const [geoBusy, setGeoBusy] = useState(false)
  const [groupByDriver, setGroupByDriver] = useState(false)
  const [collapsedGroups, setCollapsedGroups] = useState(() => new Set())
  const [selectedDate, setSelectedDate] = useState(() => toDateInput())
  const [showGeofenceWarnList, setShowGeofenceWarnList] = useState(false)

  // ---------- CSV export range state ----------
  const [exportOpen, setExportOpen] = useState(false)
  const [exportFrom, setExportFrom] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 6)
    return toDateInput(d)
  })
  const [exportTo, setExportTo] = useState(() => toDateInput())
  const [exportBusy, setExportBusy] = useState(false)

  // ---------- PDF export state ----------
  const [pdfOpen, setPdfOpen] = useState(false)
  const [pdfFrom, setPdfFrom] = useState(() => toDateInput())
  const [pdfTo, setPdfTo] = useState(() => toDateInput())
  const [pdfBusy, setPdfBusy] = useState(false)
  const [pdfProgress, setPdfProgress] = useState({ done: 0, total: 0 })
  const [pdfIncludePhotos, setPdfIncludePhotos] = useState(true)

  // ---------- DELETE range state ----------
  const [deleteRangeOpen, setDeleteRangeOpen] = useState(false)
  const [deleteFrom, setDeleteFrom] = useState(() => toDateInput())
  const [deleteTo, setDeleteTo] = useState(() => toDateInput())
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteProgress, setDeleteProgress] = useState({ done: 0, total: 0 })
  const [deleteCount, setDeleteCount] = useState(null)
  const [deletePreviewBusy, setDeletePreviewBusy] = useState(false)

  const navigate = useNavigate()

  const { toasts, push: toast, dismiss: dismissToast } = useToasts()
  const sidebarRef = useRef(null)
  const burgerRef = useRef(null)

  const isToday = selectedDate === toDateInput()

  // Auth guard
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) navigate('/')
    })
  }, [navigate])

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data?.user) setCurrentUserEmail(data.user.email)
    })
  }, [])

  const canDelete = currentUserEmail === ADMIN_EMAIL

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30000)
    return () => clearInterval(id)
  }, [])

  // ---------- Load geofence settings ----------
  const fetchGeofence = useCallback(async () => {
    const { data, error } = await supabase
      .from('geofence_settings')
      .select('*')
      .eq('id', 1)
      .maybeSingle()
    if (!error && data) {
      const g = {
        lat: Number(data.lat),
        lng: Number(data.lng),
        radiusMeters: Number(data.radius_meters),
      }
      setGeofence(g)
      setGeoDraft(g)
    }
  }, [])

  useEffect(() => { fetchGeofence() }, [fetchGeofence])

  // ---------- Load logs for selected date ----------
  const fetchLogs = useCallback(async () => {
    const { start, end } = dayBounds(selectedDate)

    const { data, error } = await supabase
      .from('attendance')
      .select('*')
      .gte('created_at', start)
      .lt('created_at', end)
      .order('created_at', { ascending: false })

    if (error) {
      console.error('Failed to fetch logs:', error.message)
      toast('Failed to load attendance logs.', 'error')
    } else if (data) {
      setLogs(data)
    }
    setLoading(false)
  }, [selectedDate, toast])

  useEffect(() => {
    setLoading(true)
    fetchLogs()

    const channel = supabase
      .channel('realtime-attendance')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'attendance' },
        (payload) => {
          if (!isSameDay(payload.new.created_at, selectedDate)) return
          setLogs((prev) => {
            if (prev.some((l) => l.id === payload.new.id)) return prev
            toast(
              `${payload.new.driver_name} ${payload.new.action_type === 'in' ? 'timed in' : 'timed out'}`,
              payload.new.action_type === 'in' ? 'success' : 'info'
            )
            return [payload.new, ...prev]
          })
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'attendance' },
        (payload) => {
          if (!isSameDay(payload.new.created_at, selectedDate)) {
            setLogs((prev) => prev.filter((l) => l.id !== payload.new.id))
            return
          }
          setLogs((prev) => prev.map((l) => (l.id === payload.new.id ? payload.new : l)))
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
    return () => { supabase.removeChannel(channel) }
  }, [fetchLogs, toast, selectedDate])

  // Mobile menu
  useEffect(() => {
    document.body.style.overflow = menuOpen ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [menuOpen])

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 761px)')
    const onChange = (e) => { if (e.matches) setMenuOpen(false) }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

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
      if (focusable.length === 0) { e.preventDefault(); return }
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
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
    const pct = timeIn ? Math.round((timeOut / timeIn) * 100) : 0
    return { total: logs.length, timeIn, timeOut, drivers, pct }
  }, [logs])

  const { driverHours, anomalies } = useMemo(
    () => computeDriverHours(logs, { liveOpenSession: isToday }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [logs, tick, isToday]
  )

  const visibleLogs = useMemo(() => {
    const q = search.trim().toLowerCase()
    return logs.filter((l) => {
      let matchFilter = true
      if (filter === 'in' || filter === 'out') {
        matchFilter = l.action_type === filter
      } else if (filter === 'overtime') {
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

  // ---------- Grouped rows ----------
  const grouped = useMemo(() => {
    const map = new Map()
    for (const log of visibleLogs) {
      const key = log.driver_name || 'Unknown'
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(log)
    }
    const arr = [...map.entries()].map(([driver, items]) => ({
      driver,
      items: items.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)),
      hours: driverHours.get(driver),
      plate: items[0]?.plate_number ?? '',
    }))
    arr.sort((a, b) => a.driver.localeCompare(b.driver))
    return arr
  }, [visibleLogs, driverHours])

  const toggleGroup = (driver) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(driver)) next.delete(driver)
      else next.add(driver)
      return next
    })
  }

  const hoursSummary = useMemo(() => {
    let completed = 0, overtime = 0, onDuty = 0, totalRemaining = 0
    for (const [, h] of driverHours) {
      if (h.overtimeHours > 0) overtime++
      else if (h.remainingHours <= 0) completed++
      if (h.isOnDuty) onDuty++
      totalRemaining += h.remainingHours
    }
    return { completed, overtime, onDuty, totalRemaining }
  }, [driverHours])

  const geoSummary = useMemo(() => {
    let inside = 0, outside = 0, unknown = 0
    for (const l of logs) {
      const geo = resolveGeofenceFor(l, geofence)
      const ok = isInsideGeofence(l.latitude, l.longitude, geo)
      if (ok === true) inside++
      else if (ok === false) outside++
      else unknown++
    }
    return { inside, outside, unknown }
  }, [logs, geofence])

  const driversBadge = useMemo(() => {
    return hoursSummary.onDuty + anomalies.size
  }, [hoursSummary.onDuty, anomalies.size])

  // ---------- OUTSIDE-GEOFENCE WARNING ----------
  const outsideGeofenceDrivers = useMemo(() => {
    if (!isToday) return []
    const list = []
    for (const [driver, h] of driverHours) {
      if (!h.isOnDuty || !h.clockedInLog) continue
      const l = h.clockedInLog
      const geo = resolveGeofenceFor(l, geofence)
      const inside = isInsideGeofence(l.latitude, l.longitude, geo)
      if (inside === false) {
        const distance = Math.round(
          haversine(l.latitude, l.longitude, geo.lat, geo.lng)
        )
        list.push({ driver, log: l, geo, distance })
      }
    }
    return list.sort((a, b) => b.distance - a.distance)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driverHours, geofence, tick, isToday])

  // ---------- DELETE ----------
  const handleDelete = async (id) => {
    if (!canDelete) return
    if (!window.confirm('Delete this attendance record?')) return
    setBusyId(id)
    const { error } = await supabase.from('attendance').delete().eq('id', id)
    if (error) toast('Failed to delete: ' + error.message, 'error')
    else {
      setLogs((prev) => prev.filter((l) => l.id !== id))
      toast('Record deleted.', 'success')
    }
    setBusyId(null)
  }

  const handleClearAll = async () => {
    if (!canDelete) return
    if (logs.length === 0) return
    if (!window.confirm(`Delete all ${logs.length} attendance record(s) from ${selectedDate}? This cannot be undone.`)) return
    setClearing(true)
    const ids = logs.map((l) => l.id)
    const { error } = await supabase.from('attendance').delete().in('id', ids)
    if (error) toast('Failed to clear: ' + error.message, 'error')
    else {
      setLogs([])
      toast(`Cleared ${ids.length} record(s).`, 'success')
    }
    setClearing(false)
  }

  // ---------- EXPORT CSV (current filtered view) ----------
  const handleExport = () => {
    if (visibleLogs.length === 0) {
      toast('Nothing to export in the current view.', 'info')
      return
    }
    const rows = visibleLogs.map((l) => {
      const d = new Date(l.created_at)
      const h = driverHours.get(l.driver_name)
      const geo = resolveGeofenceFor(l, geofence)
      const inside = isInsideGeofence(l.latitude, l.longitude, geo)
      return [
        l.driver_name ?? '', l.plate_number ?? '',
        l.action_type === 'in' ? 'TIME IN' : 'TIME OUT',
        d.toLocaleTimeString(), d.toLocaleDateString(),
        h ? formatHours(h.workedHours) : '',
        h ? formatHours(h.remainingHours) : '',
        l.latitude ?? '', l.longitude ?? '',
        inside === null ? 'Unknown' : inside ? 'Inside geofence' : 'Outside geofence',
        l.auto_closed ? 'Yes' : '',
        anomalies.has(l.id) ? 'Duplicate / out-of-order' : '',
        l.photo_url ?? '',
      ]
    })
    downloadCsv(rows, `attendance-${selectedDate}.csv`)
    toast(`Exported ${rows.length} row(s).`, 'success')
  }

  // ---------- EXPORT CSV (date range) ----------
  const runRangeExport = async (fromStr, toStr) => {
    if (!fromStr || !toStr) {
      toast('Please pick both a start and end date.', 'error')
      return
    }
    if (fromStr > toStr) {
      toast('Start date must be before (or equal to) end date.', 'error')
      return
    }

    setExportBusy(true)
    const { start } = dayBounds(fromStr)
    const { end } = dayBounds(toStr)

    const { data, error } = await supabase
      .from('attendance')
      .select('*')
      .gte('created_at', start)
      .lt('created_at', end)
      .order('created_at', { ascending: true })

    if (error) {
      setExportBusy(false)
      toast('Export failed: ' + error.message, 'error')
      return
    }
    if (!data || data.length === 0) {
      setExportBusy(false)
      toast('No records in that date range.', 'info')
      return
    }

    const { driverHours: rangeHours } = computeDriverHours(data, { liveOpenSession: false })

    const rows = data.map((l) => {
      const d = new Date(l.created_at)
      const h = rangeHours.get(l.driver_name)
      const geo = resolveGeofenceFor(l, geofence)
      const inside = isInsideGeofence(l.latitude, l.longitude, geo)
      return [
        l.driver_name ?? '', l.plate_number ?? '',
        l.action_type === 'in' ? 'TIME IN' : 'TIME OUT',
        d.toLocaleTimeString(), d.toLocaleDateString(),
        h ? formatHours(h.workedHours) : '',
        h ? formatHours(h.remainingHours) : '',
        l.latitude ?? '', l.longitude ?? '',
        inside === null ? 'Unknown' : inside ? 'Inside geofence' : 'Outside geofence',
        l.auto_closed ? 'Yes' : '',
        '',
        l.photo_url ?? '',
      ]
    })

    downloadCsv(rows, `attendance-${fromStr}_to_${toStr}.csv`)
    setExportBusy(false)
    setExportOpen(false)
    toast(`Exported ${rows.length} row(s) from ${fromStr} to ${toStr}.`, 'success')
  }

  // ---------- EXPORT PDF (with photos) ----------
  const runPdfExport = async (fromStr, toStr, includePhotos) => {
    if (!fromStr || !toStr) {
      toast('Please pick both a start and end date.', 'error')
      return
    }
    if (fromStr > toStr) {
      toast('Start date must be before (or equal to) end date.', 'error')
      return
    }

    setPdfBusy(true)
    setPdfProgress({ done: 0, total: 0 })

    const { start } = dayBounds(fromStr)
    const { end } = dayBounds(toStr)

    const { data, error } = await supabase
      .from('attendance')
      .select('*')
      .gte('created_at', start)
      .lt('created_at', end)
      .order('created_at', { ascending: true })

    if (error) {
      setPdfBusy(false)
      toast('PDF export failed: ' + error.message, 'error')
      return
    }
    if (!data || data.length === 0) {
      setPdfBusy(false)
      toast('No records in that date range.', 'info')
      return
    }

    // ---------- Pre-load photos ----------
    const photoMap = {}
    if (includePhotos) {
      const withPhotos = data.filter((l) => !!l.photo_url)
      setPdfProgress({ done: 0, total: withPhotos.length })
      let done = 0
      const CONCURRENCY = 6
      for (let i = 0; i < withPhotos.length; i += CONCURRENCY) {
        const batch = withPhotos.slice(i, i + CONCURRENCY)
        const results = await Promise.all(
          batch.map(async (l) => ({ id: l.id, dataUrl: await loadImageAsDataUrl(l.photo_url) }))
        )
        for (const r of results) photoMap[r.id] = r.dataUrl
        done += batch.length
        setPdfProgress({ done, total: withPhotos.length })
      }
    }

    // ---------- Build PDF ----------
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
    const pageW = doc.internal.pageSize.getWidth()

    doc.setFontSize(16)
    doc.setTextColor(20, 40, 70)
    doc.text('NEMINTSCO — Attendance Report', 14, 14)
    doc.setFontSize(10)
    doc.setTextColor(100, 110, 130)
    doc.text(`Range: ${formatDate(start)} → ${formatDate(end)}`, 14, 20)
    doc.text(`Total scans: ${data.length}`, 14, 25)
    doc.text(`Generated: ${new Date().toLocaleString()}`, pageW - 14, 14, { align: 'right' })

    const PHOTO_W = includePhotos ? 22 : 0
    const photoRowH = includePhotos ? 22 : 10

    const body = data.map((l) => {
      const geo = resolveGeofenceFor(l, geofence)
      const inside = isInsideGeofence(l.latitude, l.longitude, geo)
      const locationText =
        inside === null
          ? 'No GPS'
          : inside
            ? 'Inside'
            : `Outside (${Math.round(haversine(l.latitude, l.longitude, geo.lat, geo.lng))}m)`

      const row = [
        l.driver_name ?? '',
        l.plate_number ?? '',
        formatDate(l.created_at),
        formatTime(l.created_at),
        l.action_type === 'in' ? 'TIME IN' : 'TIME OUT',
        locationText,
        l.auto_closed ? 'Yes' : '',
      ]
      if (includePhotos) row.push('')
      return row
    })

    const head = includePhotos
      ? [['Driver', 'Plate', 'Date', 'Time', 'Action', 'Location', 'Auto-closed', 'Photo']]
      : [['Driver', 'Plate', 'Date', 'Time', 'Action', 'Location', 'Auto-closed']]

    autoTable(doc, {
      head,
      body,
      startY: 32,
      styles: { fontSize: 8, cellPadding: 2, valign: 'middle', minCellHeight: photoRowH },
      headStyles: { fillColor: [33, 72, 111], textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [245, 248, 252] },
      columnStyles: includePhotos ? { 7: { cellWidth: PHOTO_W, halign: 'center' } } : {},
      didDrawCell: (hook) => {
        if (!includePhotos) return
        if (hook.section !== 'body') return
        if (hook.column.index !== 7) return
        const row = data[hook.row.index]
        const dataUrl = row ? photoMap[row.id] : null
        if (!dataUrl) {
          doc.setFontSize(7)
          doc.setTextColor(150, 150, 150)
          doc.text('—', hook.cell.x + hook.cell.width / 2, hook.cell.y + hook.cell.height / 2, {
            align: 'center',
          })
          return
        }
        const pad = 1
        const maxW = hook.cell.width - pad * 2
        const maxH = hook.cell.height - pad * 2
        const imgFormat = guessImageFormat(dataUrl)
        try {
          doc.addImage(
            dataUrl,
            imgFormat,
            hook.cell.x + pad,
            hook.cell.y + pad,
            maxW,
            maxH,
            undefined,
            'FAST'
          )
        } catch {
          // Skip unsupported image formats
        }
      },
    })

    const pageCount = doc.internal.getNumberOfPages()
    for (let i = 1; i <= pageCount; i++) {
      doc.setPage(i)
      doc.setFontSize(8)
      doc.setTextColor(150, 150, 150)
      doc.text(
        `Page ${i} of ${pageCount}`,
        pageW / 2,
        doc.internal.pageSize.getHeight() - 6,
        { align: 'center' }
      )
    }

    doc.save(`attendance-${fromStr}_to_${toStr}${includePhotos ? '' : '-no-photos'}.pdf`)
    setPdfBusy(false)
    setPdfOpen(false)
    toast(`Exported PDF (${data.length} record(s)${includePhotos ? ' with photos' : ''}).`, 'success')
  }

  // ---------- Save geofence ----------
  const saveGeofence = async () => {
    setGeoBusy(true)
    const { error } = await supabase
      .from('geofence_settings')
      .update({
        lat: Number(geoDraft.lat),
        lng: Number(geoDraft.lng),
        radius_meters: Number(geoDraft.radiusMeters),
        updated_at: new Date().toISOString(),
      })
      .eq('id', 1)
    setGeoBusy(false)
    if (error) { toast('Failed to save geofence: ' + error.message, 'error'); return }
    setGeofence({
      lat: Number(geoDraft.lat),
      lng: Number(geoDraft.lng),
      radiusMeters: Number(geoDraft.radiusMeters),
    })
    setGeoEditorOpen(false)
    toast('Geofence updated.', 'success')
  }

  // ---------- DELETE range: preview ----------
  const previewRangeDelete = async (fromStr, toStr) => {
    if (!fromStr || !toStr) { setDeleteCount(null); return }
    if (fromStr > toStr) { setDeleteCount(null); return }
    setDeletePreviewBusy(true)
    const { start } = dayBounds(fromStr)
    const { end } = dayBounds(toStr)
    const { count, error } = await supabase
      .from('attendance')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', start)
      .lt('created_at', end)
    setDeletePreviewBusy(false)
    if (error) {
      toast('Could not count records: ' + error.message, 'error')
      setDeleteCount(null)
      return
    }
    setDeleteCount(count ?? 0)
  }

  // ---------- DELETE range: run ----------
  const runRangeDelete = async (fromStr, toStr) => {
    if (!canDelete) return
    if (!fromStr || !toStr) {
      toast('Please pick both a start and end date.', 'error')
      return
    }
    if (fromStr > toStr) {
      toast('Start date must be before (or equal to) end date.', 'error')
      return
    }
    if (deleteCount === 0) {
      toast('No records to delete in that range.', 'info')
      return
    }

    const confirmed = window.confirm(
      `Delete ${deleteCount ?? 'all'} attendance record(s) from ${fromStr} to ${toStr}?\n\nThis cannot be undone.`
    )
    if (!confirmed) return

    setDeleteBusy(true)
    setDeleteProgress({ done: 0, total: deleteCount || 0 })

    const { start } = dayBounds(fromStr)
    const { end } = dayBounds(toStr)

    // Fetch IDs in pages to avoid the 1000-row default limit
    const PAGE = 1000
    let allIds = []
    let offset = 0
    while (true) {
      const { data, error } = await supabase
        .from('attendance')
        .select('id')
        .gte('created_at', start)
        .lt('created_at', end)
        .order('id', { ascending: true })
        .range(offset, offset + PAGE - 1)

      if (error) {
        setDeleteBusy(false)
        toast('Failed to load records: ' + error.message, 'error')
        return
      }
      if (!data || data.length === 0) break
      allIds = allIds.concat(data.map((r) => r.id))
      if (data.length < PAGE) break
      offset += PAGE
    }

    if (allIds.length === 0) {
      setDeleteBusy(false)
      toast('No records to delete in that range.', 'info')
      return
    }

    setDeleteProgress({ done: 0, total: allIds.length })

    // Delete in chunks so we don't exceed PostgREST URL limits
    const CHUNK = 500
    let deleted = 0
    for (let i = 0; i < allIds.length; i += CHUNK) {
      const chunk = allIds.slice(i, i + CHUNK)
      const { error } = await supabase
        .from('attendance')
        .delete()
        .in('id', chunk)
      if (error) {
        setDeleteBusy(false)
        toast(`Deleted ${deleted} of ${allIds.length}. Error: ${error.message}`, 'error')
        if (selectedDate >= fromStr && selectedDate <= toStr) fetchLogs()
        return
      }
      deleted += chunk.length
      setDeleteProgress({ done: deleted, total: allIds.length })
    }

    setDeleteBusy(false)
    setDeleteRangeOpen(false)
    setDeleteCount(null)
    toast(`Deleted ${deleted} record(s) from ${fromStr} to ${toStr}.`, 'success')

    if (selectedDate >= fromStr && selectedDate <= toStr) {
      fetchLogs()
    }
  }

  // Donut
  const R = 70, C = 2 * Math.PI * R
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
    const geo = resolveGeofenceFor(log, geofence)
    const inside = isInsideGeofence(log.latitude, log.longitude, geo)
    const link = mapsLink(log.latitude, log.longitude)
    if (inside === null) {
      return <span className="ad-geo-muted" title="No GPS data captured">No GPS</span>
    }
    const cls = inside ? 'inside' : 'outside'
    const label = inside ? 'Inside' : 'Outside'
    const tip = inside
      ? `Within geofence (${geo.radiusMeters}m)`
      : `Outside geofence (${Math.round(haversine(log.latitude, log.longitude, geo.lat, geo.lng))}m away)`
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

  const renderRow = (log) => {
    const h = driverHours.get(log.driver_name)
    const isAnomaly = anomalies.has(log.id)
    return (
      <tr
        key={log.id}
        className={`${isAnomaly ? 'ad-row-anomaly' : ''} ${log.auto_closed ? 'ad-row-auto' : ''}`}
      >
        <td className="cell-driver">
          <div className="ad-driver">
            <span className="ad-avatar sm" aria-hidden="true">{initials(log.driver_name)}</span>
            <span className="ad-driver-name">{log.driver_name}</span>
            {log.auto_closed && (
              <span
                className="ad-auto-badge"
                title="Legacy forced clock-out. Safe to delete to restore active hours."
              >
                AUTO-BUG
              </span>
            )}
            {isAnomaly && (
              <span
                className="ad-anomaly-badge"
                title="Duplicate, out-of-order, or unclosed scan — ignored for hours calculation"
                aria-label="Anomaly"
              >⚠</span>
            )}
          </div>
        </td>
        <td data-label="Plate">{log.plate_number}</td>
        <td data-label="Time">{new Date(log.created_at).toLocaleTimeString()}</td>
        <td data-label="Action">
          <span className={`ad-badge ${log.action_type}`}>
            {log.action_type === 'in' ? 'TIME IN' : 'TIME OUT'}
          </span>
        </td>
        <td data-label="Location">{renderLocationCell(log)}</td>
        <td data-label="Photo">
          {log.photo_url ? (
            <a href={log.photo_url} target="_blank" rel="noopener noreferrer" title="View full photo">
              <img
                src={log.photo_url}
                alt={`${log.driver_name} ${log.action_type === 'in' ? 'time in' : 'time out'} photo`}
                loading="lazy"
                style={{ width: 40, height: 40, borderRadius: 10, objectFit: 'cover', display: 'block' }}
              />
            </a>
          ) : (
            <span className="ad-hours-muted">—</span>
          )}
        </td>
        <td data-label="Worked">
          {h ? (
            <span className="ad-worked" title="Total worked that day">
              {formatHours(h.workedHours)}
              {h.isOnDuty && <span className="ad-live-dot" title="Currently on duty" aria-label="On duty" />}
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
  }

  return (
    <div className="ad-shell">
      <div className="ad-toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`ad-toast ${t.type}`}>
            <span>{t.message}</span>
            <button className="ad-toast-close" onClick={() => dismissToast(t.id)} aria-label="Dismiss">✕</button>
          </div>
        ))}
      </div>

      <div
        className={`ad-backdrop ${menuOpen ? 'show' : ''}`}
        onClick={closeMenu}
        aria-hidden="true"
      />

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
          <button disabled className="ad-nav-with-badge">
            <span>🚕 Drivers</span>
            {driversBadge > 0 && (
              <span className="ad-nav-badge" title={`${hoursSummary.onDuty} on duty · ${anomalies.size} anomalies`}>
                {driversBadge}
              </span>
            )}
          </button>
        </nav>

        <p className="ad-nav-label">SETTINGS</p>
        <nav className="ad-nav">
          <button disabled>⚙ Settings</button>
          <button onClick={handleLogout}>⎋ Logout</button>
        </nav>
      </aside>

      <main className="ad-main">
        <header className="ad-topbar">
          <button
            ref={burgerRef}
            className="ad-burger"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label={menuOpen ? 'Close navigation menu' : 'Open navigation menu'}
            aria-expanded={menuOpen}
            aria-controls="ad-sidebar"
          >☰</button>
          <div className="ad-crumbs"><span>Dashboards</span> / <strong>Attendance</strong></div>
          <div className="ad-live" aria-label={isToday ? 'Live data' : 'Historical data'}>
            {isToday ? <><i aria-hidden="true" /> Live</> : <>📅 {selectedDate}</>}
          </div>
        </header>

        {/* ---------- Hero banner ---------- */}
        <section className="ad-hero" aria-label="Attendance overview">
          <div className="ad-hero-text">
            <h1>FLEET ATTENDANCE<br />OVERVIEW</h1>
            <p>Live time in and time out for every NEMINTSCO driver.</p>
            <div className="ad-date-controls">
              <button
                className={`ad-btn ${isToday ? 'on' : ''}`}
                onClick={() => setSelectedDate(toDateInput())}
                title="Show today's attendance"
              >Today</button>
              <button
                className="ad-btn"
                onClick={() => {
                  const y = new Date(); y.setDate(y.getDate() - 1)
                  setSelectedDate(toDateInput(y))
                }}
                title="Show yesterday's attendance"
              >Yesterday</button>
              <input
                type="date"
                className="ad-date-input"
                value={selectedDate}
                max={toDateInput()}
                onChange={(e) => setSelectedDate(e.target.value)}
                aria-label="Select attendance date"
              />
              <span className="ad-date">
                {new Date(selectedDate + 'T00:00:00').toLocaleDateString(undefined, {
                  weekday: 'long', month: 'long', day: 'numeric',
                })}
              </span>
            </div>
          </div>

          <div className="ad-hero-cards">
            <div className="ad-glass">
              <div className="t">Time in</div>
              <div className="n">{stats.timeIn}</div>
              <div className="bar"><i style={{ width: stats.timeIn ? '100%' : '0%' }} /></div>
            </div>
            <div className="ad-glass">
              <div className="t">Time out</div>
              <div className="n">{stats.timeOut}</div>
              <div className="bar"><i style={{ width: `${Math.min(100, stats.pct)}%` }} /></div>
            </div>
          </div>

          <div className="ad-hero-kpis">
            <div><strong>{hoursSummary.onDuty}</strong>On duty</div>
            <div><strong>{geoSummary.inside}</strong>In geofence</div>
          </div>
        </section>

        <section className="ad-stats" aria-label="Attendance summary">
          <div className="ad-card">
            <p>Total scans</p>
            <h2>{stats.total}</h2>
            <small className="up">{isToday ? '↗ today' : `📅 ${selectedDate}`}</small>
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
            <p>{isToday ? 'Currently on duty' : 'Unclosed sessions'}</p>
            <h2>{hoursSummary.onDuty}</h2>
            <small>{stats.drivers} unique drivers</small>
          </div>
        </section>

        <section className="ad-hours-strip" aria-label="Hours at a glance">
          <div className="ad-hours-chip"><span className="label">Target / day</span><strong>8h</strong></div>
          <div className="ad-hours-chip"><span className="label">On duty</span><strong className="lime">{hoursSummary.onDuty}</strong></div>
          <div className="ad-hours-chip"><span className="label">Completed 8h</span><strong className="lime">{hoursSummary.completed}</strong></div>
          <div className="ad-hours-chip"><span className="label">Overtime</span><strong className="red">{hoursSummary.overtime}</strong></div>
          <div className="ad-hours-chip"><span className="label">Total remaining</span><strong>{formatHours(hoursSummary.totalRemaining)}</strong></div>
        </section>

        <section className="ad-hours-strip" aria-label="Geofence summary">
          <div className="ad-hours-chip"><span className="label">Inside geofence</span><strong className="lime">{geoSummary.inside}</strong></div>
          <div className="ad-hours-chip"><span className="label">Outside geofence</span><strong className="red">{geoSummary.outside}</strong></div>
          <div className="ad-hours-chip"><span className="label">No GPS data</span><strong>{geoSummary.unknown}</strong></div>
          <div className="ad-hours-chip"><span className="label">Anomalies</span><strong className="red">{anomalies.size}</strong></div>
          <div className="ad-hours-chip ad-geo-config">
            <span className="label">Geofence · {geofence.radiusMeters}m</span>
            <div className="ad-geo-config-actions">
              <button
                className="ad-btn"
                onClick={() => { setGeoDraft(geofence); setGeoEditorOpen(true) }}
                title="Edit geofence center and radius"
              >⚙ Edit geofence</button>
            </div>
          </div>
        </section>

        {isToday && outsideGeofenceDrivers.length > 0 && (
          <section className="ad-autoclose-banner" role="alert">
            <div
              className="ad-warn-header"
              onClick={() => setShowGeofenceWarnList(v => !v)}
              style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', userSelect: 'none' }}
            >
              <strong style={{ fontSize: '16px' }}>{showGeofenceWarnList ? '▾' : '▸'}</strong>
              <strong>⚠ {outsideGeofenceDrivers.length} driver(s)</strong> currently have an open session and were last seen <b>outside the geofence</b>.
            </div>

            {showGeofenceWarnList && (
              <>
                <ul className="ad-geo-warn-list">
                  {outsideGeofenceDrivers.map((c) => (
                    <li key={c.log.id}>
                      <strong>{c.driver}</strong> — {c.distance}m away
                      {c.log.latitude != null && c.log.longitude != null && (
                        <>
                          {' '}·{' '}
                          <a
                            href={mapsLink(c.log.latitude, c.log.longitude)}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            view location
                          </a>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
                <small>Drivers are <b>not</b> clocked out automatically. Verify with the driver, then clock them out manually or adjust the geofence if the radius/center is wrong.</small>
              </>
            )}
          </section>
        )}

        <section className="ad-grid">
          <div className="ad-card ad-panel ad-panel-donut">
            <div className="ad-panel-head"><h3>Scan Overview</h3></div>
            <div className="ad-donut-wrap">
              <div className="ad-donut">
                <svg viewBox="0 0 180 180" role="img" aria-label="Scans split by type">
                  <circle cx="90" cy="90" r={R} className="ring-bg" />
                  <circle
                    cx="90" cy="90" r={R} className="ring-fg"
                    strokeDasharray={`${C * inShare} ${C}`}
                    transform="rotate(-90 90 90)"
                  />
                </svg>
                <div className="ad-donut-label">
                  <strong>{stats.total}</strong>
                  <span>Scans {isToday ? 'today' : 'that day'}</span>
                </div>
              </div>
              <ul className="ad-legend">
                <li><i className="lime" aria-hidden="true" /> Time in <b>{stats.timeIn}</b></li>
                <li><i className="dim" aria-hidden="true" /> Time out <b>{stats.timeOut}</b></li>
                <li><i className="mid" aria-hidden="true" /> Clock-out rate <b>{stats.pct}%</b></li>
              </ul>
            </div>
          </div>

          <div className="ad-card ad-panel ad-panel-activity">
            <div className="ad-panel-head"><h3>Activities</h3></div>
            <ul className="ad-activity">
              {logs.slice(0, 5).map((l) => (
                <li key={l.id}>
                  <span className={`dot ${l.action_type}`} aria-hidden="true" />
                  <div>
                    <p>{l.driver_name} {l.action_type === 'in' ? 'timed in' : 'timed out'}</p>
                    <small>{timeAgo(l.created_at)}</small>
                  </div>
                </li>
              ))}
              {logs.length === 0 && <li className="empty">No activity {isToday ? 'yet' : 'that day'}</li>}
            </ul>
          </div>
        </section>

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
              <div className="ad-group-toggle" role="group" aria-label="Display mode">
                <button
                  className={`ad-btn ${groupByDriver ? 'on' : ''}`}
                  onClick={() => setGroupByDriver((v) => !v)}
                  aria-pressed={groupByDriver}
                  title="Group rows by driver"
                >
                  ⇅ {groupByDriver ? 'Grouped' : 'Group by driver'}
                </button>
              </div>
              <div className="ad-actions">
                <button
                  className="ad-btn export"
                  onClick={handleExport}
                  disabled={visibleLogs.length === 0}
                  title={`Download ${selectedDate} view as CSV`}
                >⭳ Export CSV</button>

                <button
                  className="ad-btn export"
                  onClick={() => setExportOpen(true)}
                  title="Export records across a date range (CSV)"
                >📅 Export range</button>

                <button
                  className="ad-btn export"
                  onClick={() => { setPdfFrom(selectedDate); setPdfTo(selectedDate); setPdfOpen(true) }}
                  title="Export records with photos as PDF"
                >📄 Export PDF</button>

                {canDelete && (
                  <button
                    className="ad-btn danger"
                    onClick={handleClearAll}
                    disabled={clearing || logs.length === 0}
                    title={`Delete all attendance records from ${selectedDate}`}
                  >{clearing ? 'Clearing…' : `🗑 Clear ${selectedDate}`}</button>
                )}

                {canDelete && (
                  <button
                    className="ad-btn danger"
                    onClick={() => {
                      setDeleteFrom(exportFrom)
                      setDeleteTo(exportTo)
                      setDeleteCount(null)
                      setDeleteRangeOpen(true)
                    }}
                    title="Delete attendance records across a date range"
                  >🗑 Delete range</button>
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
                    <th scope="col">Photo</th>
                    <th scope="col">Worked</th>
                    <th scope="col">Hours left</th>
                    <th scope="col"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {visibleLogs.length === 0 ? (
                    <tr>
                      <td colSpan="9" className="ad-empty cell-empty">
                        No {filter !== 'all' ? `${filter} ` : ''}attendance records found for {selectedDate}.
                      </td>
                    </tr>
                  ) : groupByDriver ? (
                    grouped.map((g) => {
                      const isCollapsed = collapsedGroups.has(g.driver)
                      return (
                        <React.Fragment key={`g-${g.driver}`}>
                          <tr className="ad-group-row">
                            <td colSpan="9">
                              <button
                                className="ad-group-head"
                                onClick={() => toggleGroup(g.driver)}
                                aria-expanded={!isCollapsed}
                                aria-controls={`group-${g.driver}`}
                              >
                                <span className="ad-group-caret">{isCollapsed ? '▸' : '▾'}</span>
                                <span className="ad-avatar sm" aria-hidden="true">{initials(g.driver)}</span>
                                <span className="ad-group-name">{g.driver}</span>
                                <span className="ad-group-meta">
                                  {g.items.length} scan{g.items.length > 1 ? 's' : ''}
                                  {g.hours && <> · {formatHours(g.hours.workedHours)} worked</>}
                                  {g.hours?.isOnDuty && <span className="ad-live-dot" title="On duty" aria-label="On duty" />}
                                </span>
                                <span className="ad-group-hours">{renderHoursCell(g.driver)}</span>
                              </button>
                            </td>
                          </tr>
                          {!isCollapsed && g.items.map((log) => renderRow(log))}
                        </React.Fragment>
                      )
                    })
                  ) : (
                    visibleLogs.map((log) => renderRow(log))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>

      {/* ---------- Geofence editor modal ---------- */}
      {geoEditorOpen && (
        <div className="ad-modal-backdrop" onClick={() => setGeoEditorOpen(false)}>
          <div className="ad-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="geo-title">
            <h3 id="geo-title">Edit geofence</h3>
            <p className="ad-modal-help">Applied to new scans. Older records keep the geofence that was active when they were created.</p>
            <div className="ad-modal-field">
              <label>Latitude</label>
              <input
                type="number" step="any"
                value={geoDraft.lat}
                onChange={(e) => setGeoDraft({ ...geoDraft, lat: e.target.value })}
              />
            </div>
            <div className="ad-modal-field">
              <label>Longitude</label>
              <input
                type="number" step="any"
                value={geoDraft.lng}
                onChange={(e) => setGeoDraft({ ...geoDraft, lng: e.target.value })}
              />
            </div>
            <div className="ad-modal-field">
              <label>Radius (meters)</label>
              <input
                type="number" min="1"
                value={geoDraft.radiusMeters}
                onChange={(e) => setGeoDraft({ ...geoDraft, radiusMeters: e.target.value })}
              />
            </div>
            <div className="ad-modal-actions">
              <button className="ad-btn" onClick={() => setGeoEditorOpen(false)}>Cancel</button>
              <button className="ad-btn export" onClick={saveGeofence} disabled={geoBusy}>
                {geoBusy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- CSV range export modal ---------- */}
      {exportOpen && (
        <div className="ad-modal-backdrop" onClick={() => !exportBusy && setExportOpen(false)}>
          <div
            className="ad-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="export-title"
          >
            <h3 id="export-title">Export attendance by date range</h3>
            <p className="ad-modal-help">
              Records from both start and end dates are included. Times are grouped per driver within the range.
            </p>

            <div className="ad-modal-field">
              <label htmlFor="export-from">From</label>
              <input
                id="export-from"
                type="date"
                value={exportFrom}
                max={exportTo || toDateInput()}
                onChange={(e) => setExportFrom(e.target.value)}
              />
            </div>

            <div className="ad-modal-field">
              <label htmlFor="export-to">To</label>
              <input
                id="export-to"
                type="date"
                value={exportTo}
                min={exportFrom}
                max={toDateInput()}
                onChange={(e) => setExportTo(e.target.value)}
              />
            </div>

            <div className="ad-modal-actions">
              <button className="ad-btn" onClick={() => setExportOpen(false)} disabled={exportBusy}>
                Cancel
              </button>
              <button
                className="ad-btn export"
                onClick={() => runRangeExport(exportFrom, exportTo)}
                disabled={exportBusy}
              >
                {exportBusy ? 'Exporting…' : 'Export range'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- PDF export modal ---------- */}
      {pdfOpen && (
        <div className="ad-modal-backdrop" onClick={() => !pdfBusy && setPdfOpen(false)}>
          <div
            className="ad-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="pdf-title"
          >
            <h3 id="pdf-title">Export attendance as PDF</h3>
            <p className="ad-modal-help">
              Photos are embedded in the PDF. Both start and end dates are included.
            </p>

            <div className="ad-modal-field">
              <label htmlFor="pdf-from">From</label>
              <input
                id="pdf-from"
                type="date"
                value={pdfFrom}
                max={pdfTo || toDateInput()}
                onChange={(e) => setPdfFrom(e.target.value)}
                disabled={pdfBusy}
              />
            </div>

            <div className="ad-modal-field">
              <label htmlFor="pdf-to">To</label>
              <input
                id="pdf-to"
                type="date"
                value={pdfTo}
                min={pdfFrom}
                max={toDateInput()}
                onChange={(e) => setPdfTo(e.target.value)}
                disabled={pdfBusy}
              />
            </div>

            <div className="ad-modal-field" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <input
                id="pdf-photos"
                type="checkbox"
                checked={pdfIncludePhotos}
                onChange={(e) => setPdfIncludePhotos(e.target.checked)}
                disabled={pdfBusy}
              />
              <label htmlFor="pdf-photos" style={{ margin: 0 }}>
                Include photos (slower, larger file)
              </label>
            </div>

            {pdfBusy && pdfProgress.total > 0 && (
              <p className="ad-modal-help" style={{ marginTop: 0 }}>
                Loading photos… {pdfProgress.done} / {pdfProgress.total}
              </p>
            )}

            <div className="ad-modal-actions">
              <button className="ad-btn" onClick={() => setPdfOpen(false)} disabled={pdfBusy}>
                Cancel
              </button>
              <button
                className="ad-btn export"
                onClick={() => runPdfExport(pdfFrom, pdfTo, pdfIncludePhotos)}
                disabled={pdfBusy}
              >
                {pdfBusy ? 'Building PDF…' : 'Export PDF'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- DELETE range modal ---------- */}
      {deleteRangeOpen && (
        <div
          className="ad-modal-backdrop"
          onClick={() => !deleteBusy && setDeleteRangeOpen(false)}
        >
          <div
            className="ad-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-range-title"
          >
            <h3 id="delete-range-title">Delete attendance by date range</h3>
            <p className="ad-modal-help">
              Records from both start and end dates are included. This action is{' '}
              <b>permanent</b> and cannot be undone.
            </p>

            <div className="ad-modal-field">
              <label htmlFor="delete-from">From</label>
              <input
                id="delete-from"
                type="date"
                value={deleteFrom}
                max={deleteTo || toDateInput()}
                onChange={(e) => {
                  setDeleteFrom(e.target.value)
                  setDeleteCount(null)
                }}
                disabled={deleteBusy}
              />
            </div>

            <div className="ad-modal-field">
              <label htmlFor="delete-to">To</label>
              <input
                id="delete-to"
                type="date"
                value={deleteTo}
                min={deleteFrom}
                max={toDateInput()}
                onChange={(e) => {
                  setDeleteTo(e.target.value)
                  setDeleteCount(null)
                }}
                disabled={deleteBusy}
              />
            </div>

            <div className="ad-modal-field-row">
              <button
                className="ad-btn"
                onClick={() => previewRangeDelete(deleteFrom, deleteTo)}
                disabled={deleteBusy || deletePreviewBusy}
              >
                {deletePreviewBusy ? 'Counting…' : 'Preview count'}
              </button>
              {deleteCount !== null && (
                <span className="ad-modal-count">
                  {deleteCount === 0
                    ? 'No records in range.'
                    : `${deleteCount} record(s) will be deleted.`}
                </span>
              )}
            </div>

            {deleteBusy && deleteProgress.total > 0 && (
              <p className="ad-modal-help" style={{ marginTop: 0 }}>
                Deleting… {deleteProgress.done} / {deleteProgress.total}
              </p>
            )}

            <div className="ad-modal-actions">
              <button
                className="ad-btn"
                onClick={() => setDeleteRangeOpen(false)}
                disabled={deleteBusy}
              >
                Cancel
              </button>
              <button
                className="ad-btn danger"
                onClick={() => runRangeDelete(deleteFrom, deleteTo)}
                disabled={deleteBusy || deleteCount === 0}
              >
                {deleteBusy ? 'Deleting…' : 'Delete range'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}