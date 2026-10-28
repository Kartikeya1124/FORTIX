import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Shield, Eye, EyeOff, Lock, Mail, User, AlertCircle, CheckCircle2, ArrowRight, KeyRound } from 'lucide-react';

export function Login({ onLogin }: { onLogin: () => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('admin@fortix.test');
  const [password, setPassword] = useState('password123');
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [isShaking, setIsShaking] = useState(false);

  const [isForgotOpen, setIsForgotOpen] = useState(false);
  const [resetEmail, setResetEmail] = useState('');
  const [resetMessage, setResetMessage] = useState('');

  const triggerShake = () => {
    setIsShaking(true);
    setTimeout(() => setIsShaking(false), 400);
  };

  const switchMode = (nextMode: 'login' | 'register') => {
    setMode(nextMode);
    setError('');
    if (nextMode === 'register' && email === 'admin@fortix.test') {
      setEmail('');
      setPassword('');
    }
  };

  const fillDemoCredentials = () => {
    setMode('login');
    setEmail('admin@fortix.test');
    setPassword('password123');
    setError('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    const normalizedEmail = email.trim();
    if (!normalizedEmail) {
      setError('Please enter your email address.');
      triggerShake();
      return;
    }

    if (mode === 'register' && password.length < 8) {
      setError('Password must be at least 8 characters long.');
      triggerShake();
      return;
    }

    setIsSubmitting(true);
    try {
      if (mode === 'register') {
        const regRes = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: normalizedEmail,
            password,
            name: name.trim() || undefined
          })
        });

        if (!regRes.ok) {
          const errPayload = await regRes.json().catch(() => ({}));
          if (regRes.status === 409) {
            setError('An account with this email already exists. Sign in instead.');
          } else if (regRes.status === 429) {
            setError(errPayload.error || 'Too many authentication attempts. Please wait a minute and retry.');
          } else {
            setError(errPayload.error || 'Unable to create account. Check your email and password (min 8 chars).');
          }
          triggerShake();
          return;
        }
      }

      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: normalizedEmail, password })
      });

      if (res.ok) {
        const data = await res.json();
        localStorage.setItem('fortix_token', data.token);
        onLogin();
      } else {
        const errPayload = await res.json().catch(() => ({}));
        if (res.status === 429) {
          setError(errPayload.error || 'Too many login attempts. Please wait 1 minute before retrying.');
        } else {
          setError('Invalid credentials. Verify your email and password or use the sandbox admin account below.');
        }
        triggerShake();
      }
    } catch {
      setError('Unable to reach the FortiX authentication service. Check server status and try again.');
      triggerShake();
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleForgotSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetEmail.trim()) return;
    setResetMessage(`If an account exists for ${resetEmail.trim()}, password recovery instructions have been queued.`);
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-[#090b10] text-zinc-100 px-4 py-12 relative overflow-hidden">
      {/* Subtle Night Mode ambient radial backdrop */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(242,125,38,0.14),transparent_45%),radial-gradient(circle_at_80%_75%,rgba(30,64,175,0.16),transparent_50%)]"
      />

      <div className="relative z-10 w-full max-w-5xl grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-12 items-center">
        {/* Left Column: Product Identity & Security Guarantees */}
        <div className="lg:col-span-6 space-y-6">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-primary text-zinc-950 font-bold text-lg shadow-lg">
              FX
            </div>
            <div>
              <div className="text-lg font-bold tracking-tight text-white leading-none">
                FortiX Gateway
              </div>
              <div className="text-xs text-zinc-400 mt-1">
                API Security Enforcement & Continuous Resilience
              </div>
            </div>
          </div>

          <div className="space-y-3 max-w-xl">
            <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-white leading-tight">
              Protect upstream APIs and verify resilience with stored evidence.
            </h1>
            <p className="text-sm sm:text-base text-zinc-400 leading-relaxed">
              Manage scoped API keys, per-route rate limits, active WAF threat inspection, and bounded fault-injection experiments from a single control plane.
            </p>
          </div>

          <div className="pt-2 border-t border-white/10 grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
            <div>
              <div className="font-semibold text-zinc-200">Scoped Key Auth</div>
              <div className="text-zinc-400 mt-0.5 leading-relaxed">
                Hashed credentials with instant distributed revocation.
              </div>
            </div>
            <div>
              <div className="font-semibold text-zinc-200">WAF & SSRF Guard</div>
              <div className="text-zinc-400 mt-0.5 leading-relaxed">
                Per-route SQLi/XSS inspection and private-network blocking.
              </div>
            </div>
            <div>
              <div className="font-semibold text-zinc-200">Evidence Reports</div>
              <div className="text-zinc-400 mt-0.5 leading-relaxed">
                Latency, status distribution, and recovery telemetry.
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: Solid Night Mode Auth Card */}
        <div className="lg:col-span-6 flex justify-center lg:justify-end">
          <div
            className={`w-full max-w-md rounded-2xl bg-[#131622] border border-white/15 shadow-2xl p-6 sm:p-8 ${
              isShaking ? 'animate-shake' : ''
            }`}
          >
            {/* Mode Switcher Tabs */}
            <div className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-[#0a0c13] border border-white/10 mb-6">
              <button
                type="button"
                onClick={() => switchMode('login')}
                className={`py-2 px-4 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
                  mode === 'login'
                    ? 'bg-[#1c2133] text-white shadow-sm border border-white/15'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Sign In
              </button>
              <button
                type="button"
                onClick={() => switchMode('register')}
                className={`py-2 px-4 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
                  mode === 'register'
                    ? 'bg-[#1c2133] text-white shadow-sm border border-white/15'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Create Account
              </button>
            </div>

            <div className="mb-6">
              <h2 className="text-xl font-bold text-white flex items-center gap-2">
                <Shield size={18} className="text-primary shrink-0" />
                <span>{mode === 'login' ? 'Sign in to Control Plane' : 'Create Operator Account'}</span>
              </h2>
              <p className="text-xs text-zinc-400 mt-1">
                {mode === 'login'
                  ? 'Authenticate to manage gateway routes, security policies, and resilience runs.'
                  : 'Provision a new administrator workspace with isolated gateway settings.'}
              </p>
            </div>

            {error && (
              <div
                role="alert"
                className="mb-5 flex items-start gap-2.5 rounded-xl bg-red-500/12 border border-red-500/35 px-3.5 py-3 text-xs text-red-300 leading-relaxed"
              >
                <AlertCircle size={15} className="text-red-400 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              {mode === 'register' && (
                <div>
                  <label htmlFor="auth-name" className="block text-xs font-semibold text-zinc-200 mb-1.5">
                    Operator Name <span className="text-zinc-500 font-normal">(optional)</span>
                  </label>
                  <div className="relative">
                    <User size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none" />
                    <input
                      id="auth-name"
                      type="text"
                      autoComplete="name"
                      value={name}
                      onChange={e => setName(e.target.value)}
                      placeholder="Alex Rivera"
                      className="w-full rounded-xl bg-[#0a0c13] border border-white/20 pl-10 pr-3.5 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/25 transition-colors"
                    />
                  </div>
                </div>
              )}

              <div>
                <label htmlFor="auth-email" className="block text-xs font-semibold text-zinc-200 mb-1.5">
                  Email Address
                </label>
                <div className="relative">
                  <Mail size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none" />
                  <input
                    id="auth-email"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    placeholder="admin@fortix.test"
                    required
                    className="w-full rounded-xl bg-[#0a0c13] border border-white/20 pl-10 pr-3.5 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/25 transition-colors"
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label htmlFor="auth-password" className="block text-xs font-semibold text-zinc-200">
                    Password
                  </label>
                  {mode === 'login' && (
                    <button
                      type="button"
                      onClick={() => {
                        setResetEmail(email);
                        setResetMessage('');
                        setIsForgotOpen(true);
                      }}
                      className="text-xs text-zinc-400 hover:text-primary transition-colors"
                    >
                      Forgot password?
                    </button>
                  )}
                </div>
                <div className="relative">
                  <Lock size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none" />
                  <input
                    id="auth-password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder={mode === 'register' ? 'Minimum 8 characters' : 'Enter your password'}
                    required
                    minLength={mode === 'register' ? 8 : 1}
                    className="w-full rounded-xl bg-[#0a0c13] border border-white/20 pl-10 pr-10 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/25 transition-colors"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(prev => !prev)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-100 p-1 rounded-md transition-colors"
                  >
                    {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full mt-2 rounded-xl bg-primary hover:bg-primary-hover disabled:opacity-60 text-zinc-950 font-semibold text-sm py-2.5 px-4 transition-colors flex items-center justify-center gap-2 shadow-md"
              >
                <span>
                  {isSubmitting
                    ? mode === 'login'
                      ? 'Signing in...'
                      : 'Creating workspace...'
                    : mode === 'login'
                      ? 'Sign In to FortiX'
                      : 'Create Account & Sign In'}
                </span>
                {!isSubmitting && <ArrowRight size={15} />}
              </button>
            </form>

            {/* Quick Sandbox Credentials Helper */}
            <div className="mt-6 pt-5 border-t border-white/10 flex items-center justify-between gap-3">
              <div className="text-xs text-zinc-400 min-w-0">
                <span className="text-zinc-300 font-medium">Sandbox Admin:</span>{' '}
                <span className="font-mono text-zinc-300">admin@fortix.test</span>
              </div>
              <button
                type="button"
                onClick={fillDemoCredentials}
                className="px-3 py-1.5 rounded-lg bg-[#0a0c13] hover:bg-[#1c2133] border border-white/15 text-xs font-medium text-zinc-200 hover:text-white transition-colors flex items-center gap-1.5 shrink-0 whitespace-nowrap"
              >
                <KeyRound size={12} className="text-primary" />
                <span>Fill Demo Login</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Full-Screen Blurred Forgot Password Modal (Solid Night Mode Dialog) */}
      {isForgotOpen && typeof document !== 'undefined' && createPortal(
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/75 backdrop-blur-md"
          onClick={() => setIsForgotOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Reset Password"
        >
          <div
            className="w-full max-w-md rounded-2xl bg-[#141722] border border-white/15 p-6 shadow-2xl text-zinc-100 relative"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-base font-bold text-white">Password Recovery</h3>
              <button
                type="button"
                onClick={() => setIsForgotOpen(false)}
                aria-label="Close modal"
                className="text-zinc-400 hover:text-white p-1.5 rounded-lg hover:bg-white/10 transition-colors"
              >
                <X size={16} />
              </button>
            </div>

            {resetMessage ? (
              <div className="space-y-4">
                <div className="flex items-start gap-2.5 text-xs text-emerald-300 bg-emerald-500/12 border border-emerald-500/30 p-3.5 rounded-xl leading-relaxed">
                  <CheckCircle2 size={16} className="text-emerald-400 shrink-0 mt-0.5" />
                  <span>{resetMessage}</span>
                </div>
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => {
                      setIsForgotOpen(false);
                      setResetMessage('');
                    }}
                    className="px-4 py-2 rounded-xl bg-primary hover:bg-primary-hover text-zinc-950 font-semibold text-xs transition-colors"
                  >
                    Return to Sign In
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleForgotSubmit} className="space-y-4">
                <p className="text-xs text-zinc-400 leading-relaxed">
                  Enter your registered operator email address to queue a password reset token, or use the local sandbox admin credentials to sign in directly.
                </p>
                <div>
                  <label htmlFor="reset-email-input" className="block text-xs font-semibold text-zinc-200 mb-1.5">
                    Account Email
                  </label>
                  <input
                    id="reset-email-input"
                    type="email"
                    value={resetEmail}
                    onChange={e => setResetEmail(e.target.value)}
                    placeholder="operator@company.com"
                    required
                    autoFocus
                    className="w-full rounded-xl bg-[#0a0c13] border border-white/20 px-3.5 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/25 transition-colors"
                  />
                </div>
                <div className="flex items-center justify-end gap-2.5 pt-2">
                  <button
                    type="button"
                    onClick={() => setIsForgotOpen(false)}
                    className="px-4 py-2 rounded-xl text-xs font-medium text-zinc-300 hover:text-white hover:bg-white/10 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-2 rounded-xl bg-primary hover:bg-primary-hover text-zinc-950 font-semibold text-xs transition-colors whitespace-nowrap"
                  >
                    Send Recovery Link
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
