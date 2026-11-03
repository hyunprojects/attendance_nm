import { useState, useEffect } from 'react'
import { supabase } from '../supabaseClient'
import { useNavigate } from 'react-router-dom'

export default function AdminDashboard() {
  const [logs, setLogs] = useState([])
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()

  useEffect(() => {
    fetchLogs()

    // Real-time listener: When a driver scans, it updates the table instantly!
    const channel = supabase.channel('realtime-attendance')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'attendance' }, (payload) => {
        setLogs((prev) => [payload.new, ...prev])
      }).subscribe()

    return () => supabase.removeChannel(channel)
  }, [])

  const fetchLogs = async () => {
    // Get today's date at midnight
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const { data, error } = await supabase
      .from('attendance')
      .select('*')
      .gte('created_at', today.toISOString()) // Only fetch today's logs
      .order('created_at', { ascending: false })

    if (data) setLogs(data)
    setLoading(false)
  }

  const handleLogout = async () => {
    await supabase.auth.signOut()
    navigate('/')
  }

  return (
    <div style={{ padding: '20px', maxWidth: '800px', margin: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h2>Today's Attendance ({new Date().toLocaleDateString()})</h2>
        <button onClick={handleLogout} style={{ padding: '8px 16px', backgroundColor: '#d32f2f', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>Logout</button>
      </div>

      {loading ? <p>Loading...</p> : (
        <table style={{ width: '100%', borderCollapse: 'collapse', backgroundColor: 'white', boxShadow: '0 0 10px rgba(0,0,0,0.1)' }}>
          <thead>
            <tr style={{ backgroundColor: '#f4f4f4', textAlign: 'left' }}>
              <th style={{ padding: '12px', borderBottom: '1px solid #ddd' }}>Time</th>
              <th style={{ padding: '12px', borderBottom: '1px solid #ddd' }}>Driver Name</th>
              <th style={{ padding: '12px', borderBottom: '1px solid #ddd' }}>Plate Number</th>
              <th style={{ padding: '12px', borderBottom: '1px solid #ddd' }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {logs.length === 0 ? (
              <tr><td colSpan="4" style={{ padding: '12px', textAlign: 'center' }}>No attendance records yet today.</td></tr>
            ) : (
              logs.map((log) => (
                <tr key={log.id} style={{ borderBottom: '1px solid #eee' }}>
                  <td style={{ padding: '12px' }}>{new Date(log.created_at).toLocaleTimeString()}</td>
                  <td style={{ padding: '12px' }}>{log.driver_name}</td>
                  <td style={{ padding: '12px' }}>{log.plate_number}</td>
                  <td style={{ padding: '12px', color: log.action_type === 'in' ? '#2e7d32' : '#d32f2f', fontWeight: 'bold' }}>
                    {log.action_type === 'in' ? 'TIME IN' : 'TIME OUT'}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      )}
    </div>
  )
}