import { useState } from 'react'
import { supabase } from '../supabaseClient'
import { useNavigate } from 'react-router-dom'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const navigate = useNavigate()

  const handleLogin = async (e) => {
    e.preventDefault()
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    
    if (error) {
      setError(error.message)
    } else {
      navigate('/admin') // Send to dashboard on success
    }
  }

  return (
    <div style={styles.container}>
      <h2>Admin Login</h2>
      <form onSubmit={handleLogin} style={styles.form}>
        <input 
          type="email" 
          placeholder="Email" 
          value={email} 
          onChange={(e) => setEmail(e.target.value)} 
          style={styles.input}
        />
        <input 
          type="password" 
          placeholder="Password" 
          value={password} 
          onChange={(e) => setPassword(e.target.value)} 
          style={styles.input}
        />
        {error && <p style={{color: 'red'}}>{error}</p>}
        <button type="submit" style={styles.button}>Login</button>
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