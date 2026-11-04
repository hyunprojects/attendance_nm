import { useState } from 'react'
import { supabase } from '../supabaseClient'
import { useNavigate } from 'react-router-dom'
// import logo from '../assets/nemintsco-logo.png'  // <- optional: your logo

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
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

    // Route by role if you store role in user metadata
    const role = data.user?.user_metadata?.role
    navigate(role === 'staff' ? '/staff' : '/admin')
    setLoading(false)
  }

  return (
    <div className="lg-shell">
      <style>{css}</style>

      <main className="lg-card">
        {/* Logo */}
        <div className="lg-logo" aria-hidden="true">
          {/* <img src={logo} alt="" /> */}
          <svg viewBox="0 0 40 40" width="28" height="28" fill="none">
            <circle cx="20" cy="20" r="10" stroke="#eaf6ff" strokeWidth="3.5" />
            <circle cx="20" cy="20" r="16" stroke="#eaf6ff" strokeOpacity=".35" strokeWidth="2" />
          </svg>
        </div>

        <h1 className="lg-title">Welcome back</h1>
        <p className="lg-subtitle">Please enter your details to sign in.</p>

        <form className="lg-form" onSubmit={handleLogin}>
          {/* Email */}
          <div className="lg-field">
            <div className="lg-field-body">
              <label htmlFor="lg-email">Email</label>
              <input
                id="lg-email"
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="you@company.com"
                value={email}
                onChange={(e) => { setEmail(e.target.value); setError('') }}
                required
              />
            </div>
          </div>

          {/* Password */}
          <div className="lg-field">
            <div className="lg-field-body">
              <label htmlFor="lg-password">Password</label>
              <input
                id="lg-password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => { setPassword(e.target.value); setError('') }}
                required
              />
            </div>
            <button
              type="button"
              className="lg-toggle"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              aria-pressed={showPassword}
            >
              {showPassword ? (
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 3l18 18" />
                  <path d="M10.6 10.6a3 3 0 004.2 4.2" />
                  <path d="M9.9 5.1A9.8 9.8 0 0112 5c5 0 9 4.5 10 7-.4 1-1.2 2.3-2.4 3.5M6.6 6.6C4.4 8 2.8 10.2 2 12c1 2.5 5 7 10 7 1.5 0 2.9-.4 4.1-1" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2 12c1-2.5 5-7 10-7s9 4.5 10 7c-1 2.5-5 7-10 7S3 14.5 2 12z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              )}
            </button>
          </div>

          {error && (
            <p className="lg-error" role="alert">
              {error}
            </p>
          )}

          <button type="submit" className="lg-submit" disabled={loading}>
            <span>{loading ? 'Signing in…' : 'Sign in'}</span>
            {!loading && (
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            )}
          </button>
        </form>

        <p className="lg-footer">NEMINTSCO · Admin access only</p>
      </main>
    </div>
  )
}

/* ---------- Styles ---------- */
const css = `
.lg-shell {
  --lg-text: #dce8f5;
  --lg-muted: #7f95ad;
  --lg-accent: #5ec8ff;

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
  color: var(--lg-text);
  color-scheme: dark;
  text-align: left;
  background:
    radial-gradient(ellipse 70% 45% at 50% 0%, rgba(46, 130, 190, .38), transparent 70%),
    linear-gradient(180deg, #0f2740 0%, #0a1829 55%, #08111d 100%);
}
.lg-shell *,
.lg-shell *::before,
.lg-shell *::after { box-sizing: border-box; }

/* Dotted background */
.lg-shell::before {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image: radial-gradient(rgba(255, 255, 255, .08) 1px, transparent 1px);
  background-size: 14px 14px;
  -webkit-mask-image: radial-gradient(ellipse at center, #000 25%, transparent 78%);
          mask-image: radial-gradient(ellipse at center, #000 25%, transparent 78%);
}

/* ---------- Card ---------- */
.lg-card {
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

/* Glowing top edge */
.lg-card::before {
  content: '';
  position: absolute;
  top: -1px;
  left: 50%;
  width: 90px;
  height: 3px;
  transform: translateX(-50%);
  border-radius: 999px;
  background: var(--lg-accent);
  box-shadow: 0 0 28px 8px rgba(94, 200, 255, .55);
  filter: blur(1px);
}

/* Sparkle specks near the top */
.lg-card::after {
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

/* ---------- Header ---------- */
.lg-logo {
  display: grid;
  place-items: center;
  align-self: center;
  width: 52px;
  height: 52px;
  margin-bottom: 14px;
  border-radius: 16px;
  border: 1px solid rgba(120, 190, 255, .3);
  background: linear-gradient(160deg, #21486f, #132a44);
  box-shadow: 0 8px 24px rgba(0, 0, 0, .35), inset 0 1px 0 rgba(255, 255, 255, .12);
}
.lg-logo img { width: 30px; height: 30px; object-fit: contain; }

.lg-title {
  margin: 0;
  text-align: center;
  font-size: clamp(26px, 6.5vw, 34px);
  font-weight: 500;
  letter-spacing: -.3px;
  color: #c3d3e6;
}
.lg-subtitle {
  margin: 8px 0 clamp(20px, 5vw, 30px);
  text-align: center;
  font-size: clamp(14px, 3.6vw, 16px);
  color: var(--lg-muted);
}

/* ---------- Form ---------- */
.lg-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.lg-field {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-radius: 18px;
  border: 1px solid rgba(120, 160, 210, .16);
  background: rgba(20, 38, 62, .72);
  transition: border-color .15s, box-shadow .15s, background .15s;
}
.lg-field:focus-within {
  border-color: rgba(94, 200, 255, .6);
  background: rgba(24, 46, 74, .85);
  box-shadow: 0 0 0 3px rgba(94, 200, 255, .15);
}
.lg-field-body { flex: 1 1 auto; min-width: 0; }
.lg-field-body > label {
  display: block;
  font-size: 13px;
  color: var(--lg-muted);
  margin-bottom: 2px;
}

.lg-field input {
  display: block;
  width: 100%;
  min-width: 0;
  padding: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: #eaf3ff;
  font-size: 16px; /* 16px stops iOS zoom on focus */
  line-height: 1.4;
}
.lg-field input::placeholder { color: rgba(127, 149, 173, .55); }

/* Browser autofill keeps the dark look */
.lg-field input:-webkit-autofill {
  -webkit-text-fill-color: #eaf3ff;
  caret-color: #eaf3ff;
  box-shadow: 0 0 0 100px #14263e inset;
  transition: background-color 9999s;
}

.lg-toggle {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border: 0;
  border-radius: 12px;
  background: rgba(255, 255, 255, .06);
  color: #9fb4cc;
  cursor: pointer;
  transition: background .15s, color .15s;
}
.lg-toggle:hover { background: rgba(255, 255, 255, .12); color: #fff; }

.lg-error {
  margin: 0;
  padding: 10px 14px;
  border-radius: 12px;
  border: 1px solid rgba(255, 93, 93, .35);
  background: rgba(255, 93, 93, .1);
  color: #ffa3a3;
  font-size: 14px;
  line-height: 1.4;
}

.lg-submit {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  width: 100%;
  min-height: 52px;
  margin-top: 6px;
  border: 0;
  border-radius: 16px;
  background: linear-gradient(180deg, #7bd8ff 0%, #2f9bff 100%);
  color: #06223a;
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  box-shadow:
    0 10px 26px rgba(47, 155, 255, .35),
    inset 0 1px 0 rgba(255, 255, 255, .5);
  transition: filter .15s, transform .1s, opacity .15s;
}
.lg-submit:hover:not(:disabled) { filter: brightness(1.08); }
.lg-submit:active:not(:disabled) { transform: translateY(1px); }
.lg-submit:disabled { opacity: .65; cursor: not-allowed; }

.lg-footer {
  margin: clamp(18px, 4vw, 26px) 0 0;
  text-align: center;
  font-size: 13px;
  color: var(--lg-muted);
}

/* Keyboard focus */
.lg-shell :focus-visible {
  outline: 2px solid var(--lg-accent);
  outline-offset: 2px;
}
.lg-field input:focus-visible { outline: none; }

/* Small phones */
@media (max-width: 380px) {
  .lg-field { padding: 9px 12px; border-radius: 16px; }
  .lg-toggle { width: 34px; height: 34px; }
}

/* Short landscape screens: allow scrolling instead of clipping */
@media (max-height: 640px) {
  .lg-shell { align-items: flex-start; overflow-y: auto; }
  .lg-card { margin: auto; }
}

@media (prefers-reduced-motion: reduce) {
  .lg-field, .lg-toggle, .lg-submit { transition: none; }
}
`