import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext.js';
import { 
  Lock, 
  Mail, 
  User as UserIcon, 
  Eye, 
  EyeOff, 
  ArrowRight, 
  ShieldCheck, 
  Cpu, 
  Layers, 
  CheckCircle2, 
  AlertCircle, 
  KeyRound, 
  RefreshCw,
  Sparkles
} from 'lucide-react';

type AuthMode = 'login' | 'signup' | 'forgot' | 'reset';

export const AuthPage: React.FC = () => {
  const { login, register, requestPasswordReset, resetPassword } = useAuth();

  const [mode, setMode] = useState<AuthMode>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [resetToken, setResetToken] = useState('');

  // Password visibility toggles
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  // Status & feedback
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [devResetTokenHint, setDevResetTokenHint] = useState<string | null>(null);

  // Clear messages when switching tabs
  const switchMode = (newMode: AuthMode) => {
    setMode(newMode);
    setErrorMessage(null);
    setSuccessMessage(null);
    setDevResetTokenHint(null);
  };

  // Validation helpers
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const isEmailValid = emailRegex.test(email.trim());
  const isPasswordLongEnough = password.length >= 8;
  const doPasswordsMatch = password === confirmPassword;

  // Handle Login submission
  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    if (!email.trim() || !password) {
      setErrorMessage('Please provide both your email address and password.');
      return;
    }

    setIsLoading(true);
    const result = await login(email.trim(), password);
    setIsLoading(false);

    if (!result.success) {
      setErrorMessage(result.error || 'Invalid email or password.');
    }
  };

  // Handle Signup submission
  const handleSignupSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    if (!name.trim() || name.trim().length < 2) {
      setErrorMessage('Full name must be at least 2 characters long.');
      return;
    }

    if (!isEmailValid) {
      setErrorMessage('Please enter a valid email address.');
      return;
    }

    if (!isPasswordLongEnough) {
      setErrorMessage('Password must be at least 8 characters long.');
      return;
    }

    if (!doPasswordsMatch) {
      setErrorMessage('Passwords do not match. Please verify your password confirmation.');
      return;
    }

    setIsLoading(true);
    const result = await register(name.trim(), email.trim(), password, confirmPassword);
    setIsLoading(false);

    if (!result.success) {
      setErrorMessage(result.error || 'Failed to create your account.');
    }
  };

  // Handle Forgot Password submission
  const handleForgotSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setSuccessMessage(null);
    setDevResetTokenHint(null);

    if (!isEmailValid) {
      setErrorMessage('Please enter a valid email address.');
      return;
    }

    setIsLoading(true);
    const result = await requestPasswordReset(email.trim());
    setIsLoading(false);

    if (result.success) {
      setSuccessMessage(result.message);
      if (result.devToken) {
        setDevResetTokenHint(result.devToken);
        setResetToken(result.devToken);
      }
    } else {
      setErrorMessage(result.error || 'Failed to process password reset request.');
    }
  };

  // Handle Reset Password submission
  const handleResetSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setSuccessMessage(null);

    if (!resetToken.trim()) {
      setErrorMessage('Password reset token is required.');
      return;
    }

    if (!isPasswordLongEnough) {
      setErrorMessage('Password must be at least 8 characters long.');
      return;
    }

    if (!doPasswordsMatch) {
      setErrorMessage('Passwords do not match.');
      return;
    }

    setIsLoading(true);
    const result = await resetPassword(resetToken.trim(), password, confirmPassword);
    setIsLoading(false);

    if (result.success) {
      setSuccessMessage(result.message || 'Password reset successfully! You can now log in.');
      setPassword('');
      setConfirmPassword('');
      setTimeout(() => {
        switchMode('login');
      }, 2000);
    } else {
      setErrorMessage(result.error || 'Failed to reset password.');
    }
  };

  // 1-Click Evaluation Demo Fill
  const fillDemoCredentials = async () => {
    setIsLoading(true);
    setErrorMessage(null);
    // Register or login a test architect user
    const demoEmail = 'lead.architect@squadforge.dev';
    const demoPass = 'ForgeMaster#2026!';
    const demoName = 'Lead Architect';

    const loginRes = await login(demoEmail, demoPass);
    if (!loginRes.success) {
      // Create if doesn't exist yet
      const regRes = await register(demoName, demoEmail, demoPass, demoPass);
      if (!regRes.success) {
        setErrorMessage('Could not initialize demo user: ' + regRes.error);
      }
    }
    setIsLoading(false);
  };

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 flex flex-col justify-between selection:bg-amber-500/20 selection:text-amber-200">
      {/* Top Bar Brand */}
      <header className="px-6 py-4 border-b border-neutral-900 bg-neutral-950/90 backdrop-blur-md flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-amber-400/10 border border-amber-400/30 flex items-center justify-center text-amber-400">
            <Cpu className="w-4 h-4" />
          </div>
          <div>
            <span className="text-base font-bold tracking-tight text-white">SquadForge</span>
            <span className="hidden sm:inline-block ml-2 text-xs font-mono text-neutral-400 border-l border-neutral-800 pl-2">
              Autonomous AI Software Team
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-1 rounded-full flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            Zero-Trust Gateway Active
          </span>
        </div>
      </header>

      {/* Main Authentication Card */}
      <main className="flex-1 flex items-center justify-center p-4 sm:p-6 lg:p-8">
        <div className="w-full max-w-md bg-neutral-900/90 border border-neutral-800 rounded-2xl shadow-2xl p-6 sm:p-8 backdrop-blur-xl">
          {/* Header & Tabs */}
          <div className="text-center mb-6">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-amber-400/10 border border-amber-400/20 text-amber-400 mb-3">
              <Lock className="w-6 h-6" />
            </div>
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-white">
              {mode === 'login' && 'Sign in to SquadForge'}
              {mode === 'signup' && 'Create your account'}
              {mode === 'forgot' && 'Reset your password'}
              {mode === 'reset' && 'Set new password'}
            </h1>
            <p className="text-xs sm:text-sm text-neutral-400 mt-1.5">
              {mode === 'login' && 'Access your autonomous multi-agent development swarm.'}
              {mode === 'signup' && 'Join SquadForge to build full-stack apps with 10 AI models.'}
              {mode === 'forgot' && 'Enter your verified email address to receive reset instructions.'}
              {mode === 'reset' && 'Enter your reset token and your new account password.'}
            </p>
          </div>

          {/* Mode Switcher Tabs for Login / Signup */}
          {(mode === 'login' || mode === 'signup') && (
            <div className="grid grid-cols-2 p-1 bg-neutral-950 border border-neutral-800 rounded-xl mb-6 text-xs font-medium">
              <button
                type="button"
                onClick={() => switchMode('login')}
                className={`py-2 rounded-lg transition-all ${
                  mode === 'login'
                    ? 'bg-neutral-800 text-white shadow-sm font-semibold'
                    : 'text-neutral-400 hover:text-neutral-200'
                }`}
              >
                Sign In
              </button>
              <button
                type="button"
                onClick={() => switchMode('signup')}
                className={`py-2 rounded-lg transition-all ${
                  mode === 'signup'
                    ? 'bg-neutral-800 text-white shadow-sm font-semibold'
                    : 'text-neutral-400 hover:text-neutral-200'
                }`}
              >
                Create Account
              </button>
            </div>
          )}

          {/* Feedback Messages */}
          {errorMessage && (
            <div className="mb-5 p-3.5 bg-rose-500/10 border border-rose-500/30 rounded-xl flex items-start gap-2.5 text-xs text-rose-300">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-400" />
              <div className="leading-relaxed">{errorMessage}</div>
            </div>
          )}

          {successMessage && (
            <div className="mb-5 p-3.5 bg-emerald-500/10 border border-emerald-500/30 rounded-xl flex items-start gap-2.5 text-xs text-emerald-300">
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-emerald-400" />
              <div className="leading-relaxed">{successMessage}</div>
            </div>
          )}

          {/* Dev mode reset token assistant banner */}
          {devResetTokenHint && (
            <div className="mb-5 p-3.5 bg-cyan-950/40 border border-cyan-800/50 rounded-xl text-xs text-cyan-300 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-cyan-200 flex items-center gap-1.5">
                  <KeyRound className="w-3.5 h-3.5" />
                  Development Reset Token
                </span>
                <span className="font-mono text-[10px] text-cyan-400 bg-cyan-900/40 px-2 py-0.5 rounded">
                  Local Simulation
                </span>
              </div>
              <p className="text-[11px] text-neutral-400">
                Email delivery service is currently not configured in production. Your one-time reset token has been generated below:
              </p>
              <div className="p-2 bg-neutral-950 border border-cyan-900/60 rounded font-mono text-[11px] text-cyan-300 break-all select-all">
                {devResetTokenHint}
              </div>
              <button
                type="button"
                onClick={() => switchMode('reset')}
                className="w-full py-1.5 px-3 bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/30 text-cyan-200 rounded text-xs font-medium transition-colors"
              >
                Proceed to Reset Password Form →
              </button>
            </div>
          )}

          {/* 1. LOGIN FORM */}
          {mode === 'login' && (
            <form onSubmit={handleLoginSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-neutral-300 mb-1.5">
                  Email Address
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-neutral-500">
                    <Mail className="w-4 h-4" />
                  </div>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="architect@company.com"
                    autoComplete="email"
                    required
                    className="w-full pl-9 pr-3 py-2.5 text-sm bg-neutral-950 border border-neutral-800 rounded-xl text-white placeholder-neutral-600 focus:outline-none focus:border-amber-400 transition-colors"
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-medium text-neutral-300">
                    Password
                  </label>
                  <button
                    type="button"
                    onClick={() => switchMode('forgot')}
                    className="text-xs text-amber-400 hover:text-amber-300 transition-colors"
                  >
                    Forgot password?
                  </button>
                </div>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-neutral-500">
                    <Lock className="w-4 h-4" />
                  </div>
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••••••"
                    autoComplete="current-password"
                    required
                    className="w-full pl-9 pr-10 py-2.5 text-sm bg-neutral-950 border border-neutral-800 rounded-xl text-white placeholder-neutral-600 focus:outline-none focus:border-amber-400 transition-colors"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute inset-y-0 right-0 pr-3 flex items-center text-neutral-500 hover:text-neutral-300 transition-colors"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={isLoading}
                className="w-full py-2.5 px-4 bg-amber-400 hover:bg-amber-300 disabled:bg-amber-400/50 text-neutral-950 font-semibold text-sm rounded-xl transition-all shadow-md flex items-center justify-center gap-2 mt-2"
              >
                {isLoading ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>Signing in...</span>
                  </>
                ) : (
                  <>
                    <span>Sign In</span>
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>

              <div className="pt-2 text-center">
                <span className="text-xs text-neutral-400">
                  Don't have an account?{' '}
                  <button
                    type="button"
                    onClick={() => switchMode('signup')}
                    className="text-amber-400 hover:underline font-medium"
                  >
                    Sign up now
                  </button>
                </span>
              </div>
            </form>
          )}

          {/* 2. SIGNUP FORM */}
          {mode === 'signup' && (
            <form onSubmit={handleSignupSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-neutral-300 mb-1.5">
                  Full Name
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-neutral-500">
                    <UserIcon className="w-4 h-4" />
                  </div>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Alex Vance"
                    autoComplete="name"
                    required
                    className="w-full pl-9 pr-3 py-2.5 text-sm bg-neutral-950 border border-neutral-800 rounded-xl text-white placeholder-neutral-600 focus:outline-none focus:border-amber-400 transition-colors"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-neutral-300 mb-1.5">
                  Email Address
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-neutral-500">
                    <Mail className="w-4 h-4" />
                  </div>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="alex@company.com"
                    autoComplete="email"
                    required
                    className="w-full pl-9 pr-3 py-2.5 text-sm bg-neutral-950 border border-neutral-800 rounded-xl text-white placeholder-neutral-600 focus:outline-none focus:border-amber-400 transition-colors"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-neutral-300 mb-1.5">
                  Password
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-neutral-500">
                    <Lock className="w-4 h-4" />
                  </div>
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Minimum 8 characters"
                    autoComplete="new-password"
                    required
                    className="w-full pl-9 pr-10 py-2.5 text-sm bg-neutral-950 border border-neutral-800 rounded-xl text-white placeholder-neutral-600 focus:outline-none focus:border-amber-400 transition-colors"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute inset-y-0 right-0 pr-3 flex items-center text-neutral-500 hover:text-neutral-300 transition-colors"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <div className="flex items-center gap-2 mt-1.5 text-[11px] text-neutral-400">
                  <span className={`w-1.5 h-1.5 rounded-full ${isPasswordLongEnough ? 'bg-emerald-400' : 'bg-neutral-600'}`} />
                  <span>At least 8 characters</span>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-neutral-300 mb-1.5">
                  Confirm Password
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-neutral-500">
                    <Lock className="w-4 h-4" />
                  </div>
                  <input
                    type={showConfirmPassword ? 'text' : 'password'}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Re-enter your password"
                    autoComplete="new-password"
                    required
                    className="w-full pl-9 pr-10 py-2.5 text-sm bg-neutral-950 border border-neutral-800 rounded-xl text-white placeholder-neutral-600 focus:outline-none focus:border-amber-400 transition-colors"
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                    className="absolute inset-y-0 right-0 pr-3 flex items-center text-neutral-500 hover:text-neutral-300 transition-colors"
                    aria-label={showConfirmPassword ? 'Hide password' : 'Show password'}
                  >
                    {showConfirmPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                {confirmPassword && (
                  <div className="flex items-center gap-2 mt-1.5 text-[11px]">
                    <span className={`w-1.5 h-1.5 rounded-full ${doPasswordsMatch ? 'bg-emerald-400' : 'bg-rose-400'}`} />
                    <span className={doPasswordsMatch ? 'text-emerald-400' : 'text-rose-400'}>
                      {doPasswordsMatch ? 'Passwords match' : 'Passwords do not match'}
                    </span>
                  </div>
                )}
              </div>

              <button
                type="submit"
                disabled={isLoading}
                className="w-full py-2.5 px-4 bg-amber-400 hover:bg-amber-300 disabled:bg-amber-400/50 text-neutral-950 font-semibold text-sm rounded-xl transition-all shadow-md flex items-center justify-center gap-2 mt-2"
              >
                {isLoading ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>Creating account...</span>
                  </>
                ) : (
                  <>
                    <span>Create Account</span>
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>

              <div className="pt-2 text-center">
                <span className="text-xs text-neutral-400">
                  Already have an account?{' '}
                  <button
                    type="button"
                    onClick={() => switchMode('login')}
                    className="text-amber-400 hover:underline font-medium"
                  >
                    Sign in
                  </button>
                </span>
              </div>
            </form>
          )}

          {/* 3. FORGOT PASSWORD FORM */}
          {mode === 'forgot' && (
            <form onSubmit={handleForgotSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-neutral-300 mb-1.5">
                  Account Email Address
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-neutral-500">
                    <Mail className="w-4 h-4" />
                  </div>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@company.com"
                    required
                    className="w-full pl-9 pr-3 py-2.5 text-sm bg-neutral-950 border border-neutral-800 rounded-xl text-white placeholder-neutral-600 focus:outline-none focus:border-amber-400 transition-colors"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={isLoading}
                className="w-full py-2.5 px-4 bg-amber-400 hover:bg-amber-300 disabled:bg-amber-400/50 text-neutral-950 font-semibold text-sm rounded-xl transition-all shadow-md flex items-center justify-center gap-2"
              >
                {isLoading ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>Processing request...</span>
                  </>
                ) : (
                  <>
                    <span>Send Reset Instructions</span>
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>

              <div className="flex items-center justify-between pt-2 text-xs">
                <button
                  type="button"
                  onClick={() => switchMode('login')}
                  className="text-neutral-400 hover:text-white transition-colors"
                >
                  ← Back to Sign In
                </button>
                <button
                  type="button"
                  onClick={() => switchMode('reset')}
                  className="text-amber-400 hover:underline"
                >
                  Already have a reset token?
                </button>
              </div>
            </form>
          )}

          {/* 4. RESET PASSWORD FORM */}
          {mode === 'reset' && (
            <form onSubmit={handleResetSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-neutral-300 mb-1.5">
                  Reset Token
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-neutral-500">
                    <KeyRound className="w-4 h-4" />
                  </div>
                  <input
                    type="text"
                    value={resetToken}
                    onChange={(e) => setResetToken(e.target.value)}
                    placeholder="Enter 64-character token"
                    required
                    className="w-full pl-9 pr-3 py-2.5 text-xs bg-neutral-950 border border-neutral-800 rounded-xl text-white font-mono placeholder-neutral-600 focus:outline-none focus:border-amber-400 transition-colors"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-neutral-300 mb-1.5">
                  New Password
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-neutral-500">
                    <Lock className="w-4 h-4" />
                  </div>
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Minimum 8 characters"
                    required
                    className="w-full pl-9 pr-10 py-2.5 text-sm bg-neutral-950 border border-neutral-800 rounded-xl text-white placeholder-neutral-600 focus:outline-none focus:border-amber-400 transition-colors"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute inset-y-0 right-0 pr-3 flex items-center text-neutral-500 hover:text-neutral-300"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-neutral-300 mb-1.5">
                  Confirm New Password
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-neutral-500">
                    <Lock className="w-4 h-4" />
                  </div>
                  <input
                    type={showConfirmPassword ? 'text' : 'password'}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Confirm new password"
                    required
                    className="w-full pl-9 pr-10 py-2.5 text-sm bg-neutral-950 border border-neutral-800 rounded-xl text-white placeholder-neutral-600 focus:outline-none focus:border-amber-400 transition-colors"
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                    className="absolute inset-y-0 right-0 pr-3 flex items-center text-neutral-500 hover:text-neutral-300"
                  >
                    {showConfirmPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={isLoading}
                className="w-full py-2.5 px-4 bg-amber-400 hover:bg-amber-300 disabled:bg-amber-400/50 text-neutral-950 font-semibold text-sm rounded-xl transition-all shadow-md flex items-center justify-center gap-2"
              >
                {isLoading ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>Updating password...</span>
                  </>
                ) : (
                  <>
                    <span>Reset Password</span>
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>

              <div className="pt-2 text-center">
                <button
                  type="button"
                  onClick={() => switchMode('login')}
                  className="text-xs text-neutral-400 hover:text-white transition-colors"
                >
                  ← Back to Sign In
                </button>
              </div>
            </form>
          )}

          {/* Quick Demo Evaluation Access */}
          <div className="mt-6 pt-5 border-t border-neutral-800/80">
            <button
              type="button"
              onClick={fillDemoCredentials}
              disabled={isLoading}
              className="w-full py-2 px-3 text-xs font-mono text-amber-300 bg-amber-400/5 hover:bg-amber-400/10 border border-amber-400/20 rounded-xl transition-colors flex items-center justify-center gap-2"
            >
              <Sparkles className="w-3.5 h-3.5 text-amber-400" />
              <span>1-Click Evaluator Login (@lead.architect)</span>
            </button>
          </div>
        </div>
      </main>

      {/* Security Architecture Verification Footer */}
      <footer className="border-t border-neutral-900 bg-neutral-950/80 py-4 px-6 text-[11px] text-neutral-500 font-mono">
        <div className="max-w-5xl mx-auto flex flex-col md:flex-row items-center justify-between gap-3 text-center md:text-left">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>Secure Backend Authentication: Argon2id/Bcrypt · AES-256-GCM Vault · HTTP-Only Cookies · Brute-Force Rate Limiter</span>
          </div>
          <div className="text-neutral-400">
            SquadForge Enterprise v2.4
          </div>
        </div>
      </footer>
    </div>
  );
};
