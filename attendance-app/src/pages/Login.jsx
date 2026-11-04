import { useState } from 'react'
import { supabase } from '../supabaseClient'
import { useNavigate } from 'react-router-dom'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()

  const handleLogin = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    const { data, error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    })

    if (error) {
      // Friendlier messages for the two most common cases
      if (error.message.includes('Invalid login credentials')) {
        setError('Wrong email or password.')
      } else if (error.message.includes('Email not confirmed')) {
        setError('Please confirm your email first (check your inbox).')
      } else {
        setError(error.message)
      }
      setLoading(false)
      return
    }

    // OPTIONAL: route by role if you store role in user metadata
    const role = data.user?.user_metadata?.role
    navigate(role === 'staff' ? '/staff' : '/admin')
    setLoading(false)
  }

  return (
    <div style={styles.container}>
      <h2>Admin Login</h2>
      <form onSubmit={handleLogin} style={styles.form}>
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => { setEmail(e.target.value); setError('') }}
          style={styles.input}
          required
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => { setPassword(e.target.value); setError('') }}
          style={styles.input}
          required
        />
        {error && <p style={{ color: 'red', margin: 0 }}>{error}</p>}
        <button type="submit" style={styles.button} disabled={loading}>
          {loading ? 'Logging in…' : 'Login'}
        </button>
      </form>
    </div>
  )
}

const styles = {
  container: { backgroundColor: 'white', padding: '30px', borderRadius: '12px', width: '100%', maxWidth: '400px', textAlign: 'center', margin: 'auto', marginTop: '50px' },
  form: { display: 'flex', flexDirection: 'column', gap: '15px' },
  input: { padding: '12px', fontSize: '16px', border: '1px solid #ccc', borderRadius: '6px' },
  button: { padding: '12px', fontSize: '16px', backgroundColor: '#1976d2', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer' }
}