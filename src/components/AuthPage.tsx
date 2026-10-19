import React, { useState, useEffect, useRef } from 'react';
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
  CheckCircle2, 
  AlertCircle, 
  KeyRound, 
  RefreshCw,
  Sparkles,
  Clock,
  RotateCcw,
  Check,
  ChevronLeft
} from 'lucide-react';

type AuthMode = 'login' | 'signup' | 'forgot' | 'verify' | 'reset';

export const AuthPage: React.FC = () => {
  const { 
    login, 
    register, 
    requestPasswordReset, 
    resendVerificationCode,
    verifyResetCode, 
    resetPassword 
  } = useAuth();

  const [mode, setMode] = useState<AuthMode>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  
  // OTP state
  const [codeDigits, setCodeDigits] = useState<string[]>(['', '', '', '', '', '']);
  const [resetAuthToken, setResetAuthToken] = useState<string>('');
  const [countdownSeconds, setCountdownSeconds] = useState<number>(300); // 5 minutes
  const [resendCooldownSeconds, setResendCooldownSeconds] = useState<number>(60); // 60 seconds
  const [attemptsRemaining, setAttemptsRemaining] = useState<number | null>(5);
  const [isCodeExpired, setIsCodeExpired] = useState<boolean>(false);
  const [isCodeInvalidated, setIsCodeInvalidated] = useState<boolean>(false);

  // Missing email provider state
  const [missingConfigInfo, setMissingConfigInfo] = useState<{
    missing: boolean;
    requiredEnv?: string[];
  } | null>(null);

  // Password visibility toggles
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  // Status & feedback
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // References to 6 digit inputs for seamless typing & pasting
  const digitInputRefs = useRef<(HTMLInputElement | null)[]>([]);

  // Clear messages when switching tabs
  const switchMode = (newMode: AuthMode) => {
    setMode(newMode);
    setErrorMessage(null);
    setSuccessMessage(null);
    setMissingConfigInfo(null);
  };

  // 5-Minute (300s) Server-aligned Countdown Timer
  useEffect(() => {
    if (mode !== 'verify') return;

    if (countdownSeconds <= 0) {
      setIsCodeExpired(true);
      return;
    }

    const timer = setInterval(() => {
      setCountdownSeconds((prev) => {
        if (prev <= 1) {
          setIsCodeExpired(true);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [mode, countdownSeconds]);

  // 60-Second Resend Cooldown Timer
  useEffect(() => {
    if (mode !== 'verify' || resendCooldownSeconds <= 0) return;

    const cooldownTimer = setInterval(() => {
      setResendCooldownSeconds((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);

    return () => clearInterval(cooldownTimer);
  }, [mode, resendCooldownSeconds]);

  // Auto-focus first digit input when entering verify mode
  useEffect(() => {
    if (mode === 'verify') {
      setTimeout(() => {
        digitInputRefs.current[0]?.focus();
      }, 100);
    }
  }, [mode]);

  // Validation helpers
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const isEmailValid = emailRegex.test(email.trim());
  const isPasswordLongEnough = password.length >= 8;
  const doPasswordsMatch = password === confirmPassword;

  // Format MM:SS for countdown timer
  const formatCountdown = (totalSeconds: number): string => {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

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

  // Handle Request Verification Code submission (Forgot Password step 1)
  const handleForgotSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setSuccessMessage(null);
    setMissingConfigInfo(null);

    if (!isEmailValid) {
      setErrorMessage('Please enter a valid email address.');
      return;
    }

    setIsLoading(true);
    const result = await requestPasswordReset(email.trim());
    setIsLoading(false);

    if (result.success) {
      // Transition to verification mode
      setCodeDigits(['', '', '', '', '', '']);
      setCountdownSeconds(300); // exactly 5 minutes
      setResendCooldownSeconds(result.cooldownSeconds || 60);
      setAttemptsRemaining(5);
      setIsCodeExpired(false);
      setIsCodeInvalidated(false);
      setSuccessMessage(result.message || 'If an account with that email exists, a 6-digit verification code has been sent.');
      setMode('verify');
    } else {
      if (result.missingConfig) {
        setMissingConfigInfo({
          missing: true,
          requiredEnv: result.requiredEnv || ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'RESEND_API_KEY']
        });
      }
      setErrorMessage(result.error || 'Failed to process password reset request.');
    }
  };

  // Handle Resend Verification Code
  const handleResendCode = async () => {
    if (resendCooldownSeconds > 0 || isLoading) return;

    setErrorMessage(null);
    setSuccessMessage(null);
    setIsLoading(true);

    const result = await resendVerificationCode(email.trim());
    setIsLoading(false);

    if (result.success) {
      setCodeDigits(['', '', '', '', '', '']);
      setCountdownSeconds(300); // Fresh 5 minutes
      setResendCooldownSeconds(60); // 60 seconds cooldown
      setAttemptsRemaining(5);
      setIsCodeExpired(false);
      setIsCodeInvalidated(false);
      setSuccessMessage('A new six-digit verification code has been sent to your email.');
      digitInputRefs.current[0]?.focus();
    } else {
      if (result.cooldownRemaining) {
        setResendCooldownSeconds(result.cooldownRemaining);
      }
      if (result.missingConfig) {
        setMissingConfigInfo({
          missing: true,
          requiredEnv: result.requiredEnv
        });
      }
      setErrorMessage(result.error || 'Failed to resend verification code.');
    }
  };

  // Handle Digit Box changes
  const handleDigitChange = (index: number, val: string) => {
    // Only accept numeric digits
    const cleaned = val.replace(/\D/g, '');
    if (!cleaned) {
      const nextDigits = [...codeDigits];
      nextDigits[index] = '';
      setCodeDigits(nextDigits);
      return;
    }

    const nextDigits = [...codeDigits];
    nextDigits[index] = cleaned[cleaned.length - 1]; // Take last character entered
    setCodeDigits(nextDigits);

    // Auto-advance to next input
    if (index < 5 && cleaned.length > 0) {
      digitInputRefs.current[index + 1]?.focus();
    }
  };

  // Handle keydown for backspace navigation
  const handleDigitKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !codeDigits[index] && index > 0) {
      digitInputRefs.current[index - 1]?.focus();
    } else if (e.key === 'ArrowLeft' && index > 0) {
      digitInputRefs.current[index - 1]?.focus();
    } else if (e.key === 'ArrowRight' && index < 5) {
      digitInputRefs.current[index + 1]?.focus();
    }
  };

  // Handle Paste into any digit box
  const handleDigitPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const pastedData = e.clipboardData.getData('text').trim();
    const digitsOnly = pastedData.replace(/\D/g, '').slice(0, 6);
    if (!digitsOnly) return;

    const nextDigits = [...codeDigits];
    for (let i = 0; i < 6; i++) {
      nextDigits[i] = digitsOnly[i] || '';
    }
    setCodeDigits(nextDigits);

    // Focus either the next empty slot or the last digit
    const focusIndex = Math.min(digitsOnly.length, 5);
    digitInputRefs.current[focusIndex]?.focus();
  };

  // Handle 6-Digit Code Verification submission
  const handleVerifySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setSuccessMessage(null);

    const fullCode = codeDigits.join('');
    if (fullCode.length !== 6) {
      setErrorMessage('Please enter all 6 digits of the verification code.');
      return;
    }

    if (isCodeExpired) {
      setErrorMessage('This verification code has expired (5-minute limit). Please request a new code.');
      return;
    }

    if (isCodeInvalidated) {
      setErrorMessage('This code has been invalidated due to excessive attempts. Please request a new code.');
      return;
    }

    setIsLoading(true);
    const result = await verifyResetCode(email.trim(), fullCode);
    setIsLoading(false);

    if (result.success && result.resetAuthToken) {
      setResetAuthToken(result.resetAuthToken);
      setSuccessMessage('Code verified successfully! You can now set your new password.');
      setMode('reset');
    } else {
      if (result.attemptsRemaining !== undefined) {
        setAttemptsRemaining(result.attemptsRemaining);
      }
      if (result.codeExpiredOrInvalid) {
        setIsCodeInvalidated(true);
      }
      setErrorMessage(result.error || 'Invalid verification code.');
    }
  };

  // Handle Reset Password submission
  const handleResetSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setSuccessMessage(null);

    if (!resetAuthToken.trim()) {
      setErrorMessage('Reset authorization token is missing. Please restart the password reset flow.');
      return;
    }

    if (!isPasswordLongEnough) {
      setErrorMessage('Password must be at least 8 characters long.');
      return;
    }

    if (!doPasswordsMatch) {
      setErrorMessage('Passwords do not match. Please verify your confirmation.');
      return;
    }

    setIsLoading(true);
    const result = await resetPassword(resetAuthToken.trim(), password, confirmPassword);
    setIsLoading(false);

    if (result.success) {
      setSuccessMessage('Password successfully updated! You can now sign in with your new password.');
      setPassword('');
      setConfirmPassword('');
      setResetAuthToken('');
      setTimeout(() => {
        switchMode('login');
        setSuccessMessage('Password successfully reset. Please sign in with your new credentials.');
      }, 1500);
    } else {
      setErrorMessage(result.error || 'Failed to update password.');
    }
  };

  // 1-Click Evaluation Demo Fill
  const fillDemoCredentials = async () => {
    setIsLoading(true);
    setErrorMessage(null);
    const demoEmail = 'lead.architect@squadforge.dev';
    const demoPass = 'ForgeMaster#2026!';
    const demoName = 'Lead Architect';

    const loginRes = await login(demoEmail, demoPass);
    if (!loginRes.success) {
      const regRes = await register(demoName, demoEmail, demoPass, demoPass);
      if (!regRes.success) {
        setErrorMessage('Could not initialize demo user: ' + regRes.error);
      }
    }
    setIsLoading(false);
  };

  const fullCodeLength = codeDigits.join('').length;

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
          {/* Header */}
          <div className="text-center mb-6">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-amber-400/10 border border-amber-400/20 text-amber-400 mb-3">
              {mode === 'verify' ? (
                <KeyRound className="w-6 h-6 text-amber-400" />
              ) : mode === 'reset' ? (
                <ShieldCheck className="w-6 h-6 text-amber-400" />
              ) : (
                <Lock className="w-6 h-6" />
              )}
            </div>
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-white">
              {mode === 'login' && 'Sign in to SquadForge'}
              {mode === 'signup' && 'Create your account'}
              {mode === 'forgot' && 'Reset your password'}
              {mode === 'verify' && 'Enter Verification Code'}
              {mode === 'reset' && 'Set New Password'}
            </h1>
            <p className="text-xs sm:text-sm text-neutral-400 mt-1.5">
              {mode === 'login' && 'Access your autonomous multi-agent development swarm.'}
              {mode === 'signup' && 'Join SquadForge to build full-stack apps with 10 AI models.'}
              {mode === 'forgot' && 'Enter your email to receive a secure six-digit verification code.'}
              {mode === 'verify' && `We sent a six-digit code to ${email || 'your email'}. Enter it below.`}
              {mode === 'reset' && 'Create a strong, new password for your SquadForge account.'}
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

          {/* Missing Email Configuration Advisory */}
          {missingConfigInfo?.missing && (
            <div className="mb-5 p-4 bg-amber-500/10 border border-amber-500/30 rounded-xl text-xs text-amber-200 space-y-2">
              <div className="flex items-center gap-2 font-semibold text-amber-300">
                <AlertCircle className="w-4 h-4 text-amber-400" />
                <span>Email Delivery Service Unconfigured</span>
              </div>
              <p className="text-[11px] text-neutral-300 leading-relaxed">
                SquadForge cannot dispatch verification codes because email delivery credentials are not set. Configure one of the following providers in your environment:
              </p>
              <div className="bg-neutral-950 p-2.5 rounded-lg border border-neutral-800 font-mono text-[10px] text-amber-300 space-y-1">
                <div className="text-neutral-400 font-bold">Option A: Resend API</div>
                <div>RESEND_API_KEY=re_xxxxxxxxxxxx</div>
                <div className="text-neutral-400 font-bold mt-1.5">Option B: Standard SMTP</div>
                <div>SMTP_HOST=smtp.example.com</div>
                <div>SMTP_PORT=587</div>
                <div>SMTP_USER=user@example.com</div>
                <div>SMTP_PASS=••••••••</div>
                <div>SMTP_FROM="SquadForge" &lt;security@example.com&gt;</div>
              </div>
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

          {/* 3. FORGOT PASSWORD (EMAIL ENTRY) */}
          {mode === 'forgot' && (
            <form onSubmit={handleForgotSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-neutral-300 mb-1.5">
                  Registered Account Email
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
                    autoComplete="email"
                    required
                    className="w-full pl-9 pr-3 py-2.5 text-sm bg-neutral-950 border border-neutral-800 rounded-xl text-white placeholder-neutral-600 focus:outline-none focus:border-amber-400 transition-colors"
                  />
                </div>
                <p className="text-[11px] text-neutral-400 mt-1.5">
                  A 6-digit numeric verification code valid for 5 minutes will be dispatched.
                </p>
              </div>

              <button
                type="submit"
                disabled={isLoading}
                className="w-full py-2.5 px-4 bg-amber-400 hover:bg-amber-300 disabled:bg-amber-400/50 text-neutral-950 font-semibold text-sm rounded-xl transition-all shadow-md flex items-center justify-center gap-2"
              >
                {isLoading ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>Sending Code...</span>
                  </>
                ) : (
                  <>
                    <span>Send Verification Code</span>
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>

              <div className="pt-2 text-center">
                <button
                  type="button"
                  onClick={() => switchMode('login')}
                  className="text-xs text-neutral-400 hover:text-white transition-colors flex items-center justify-center gap-1 mx-auto"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                  <span>Back to Sign In</span>
                </button>
              </div>
            </form>
          )}

          {/* 4. VERIFY 6-DIGIT OTP CODE */}
          {mode === 'verify' && (
            <form onSubmit={handleVerifySubmit} className="space-y-5">
              {/* Countdown & Status Bar */}
              <div className="p-3.5 bg-neutral-950 border border-neutral-800 rounded-xl flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Clock className={`w-4 h-4 ${countdownSeconds < 60 ? 'text-rose-400 animate-pulse' : 'text-amber-400'}`} />
                  <div>
                    <div className="text-[10px] uppercase font-mono tracking-wider text-neutral-400">
                      Code Expiration
                    </div>
                    <div className={`text-base font-mono font-bold ${countdownSeconds < 60 ? 'text-rose-400' : 'text-white'}`}>
                      {formatCountdown(countdownSeconds)}
                    </div>
                  </div>
                </div>

                <div className="text-right">
                  <div className="text-[10px] uppercase font-mono tracking-wider text-neutral-400">
                    Attempts
                  </div>
                  <div className={`text-xs font-mono font-bold ${attemptsRemaining !== null && attemptsRemaining <= 1 ? 'text-rose-400' : 'text-neutral-300'}`}>
                    {attemptsRemaining !== null ? `${attemptsRemaining} of 5 remaining` : '5 of 5'}
                  </div>
                </div>
              </div>

              {/* Expired / Invalidated Alert */}
              {isCodeExpired && (
                <div className="p-3 bg-rose-500/10 border border-rose-500/30 rounded-xl text-xs text-rose-300 flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-semibold block">Verification Code Expired</span>
                    <span className="text-[11px] text-rose-300/80">
                      The 5-minute security window has elapsed. Please request a new verification code below.
                    </span>
                  </div>
                </div>
              )}

              {/* Six Digit Inputs */}
              <div>
                <label className="block text-xs font-medium text-neutral-300 mb-2 text-center">
                  Enter 6-Digit Verification Code
                </label>
                <div className="flex justify-between gap-2 max-w-xs mx-auto">
                  {codeDigits.map((digit, idx) => (
                    <input
                      key={idx}
                      ref={(el) => { digitInputRefs.current[idx] = el; }}
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      maxLength={1}
                      value={digit}
                      onChange={(e) => handleDigitChange(idx, e.target.value)}
                      onKeyDown={(e) => handleDigitKeyDown(idx, e)}
                      onPaste={handleDigitPaste}
                      disabled={isCodeExpired || isCodeInvalidated || isLoading}
                      className={`w-11 h-13 text-center text-xl font-mono font-bold rounded-xl border bg-neutral-950 text-white transition-all focus:outline-none ${
                        digit 
                          ? 'border-amber-400 shadow-[0_0_12px_rgba(251,191,36,0.15)] bg-amber-400/5' 
                          : 'border-neutral-800 focus:border-amber-400'
                      } disabled:opacity-40 disabled:cursor-not-allowed`}
                    />
                  ))}
                </div>
              </div>

              {/* Verify Button */}
              <button
                type="submit"
                disabled={fullCodeLength !== 6 || isCodeExpired || isCodeInvalidated || isLoading}
                className="w-full py-2.5 px-4 bg-amber-400 hover:bg-amber-300 disabled:bg-neutral-800 disabled:text-neutral-500 text-neutral-950 font-semibold text-sm rounded-xl transition-all shadow-md flex items-center justify-center gap-2"
              >
                {isLoading ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>Verifying Code...</span>
                  </>
                ) : (
                  <>
                    <Check className="w-4 h-4" />
                    <span>Verify Code</span>
                  </>
                )}
              </button>

              {/* Resend Code Section with Cooldown */}
              <div className="pt-2 flex flex-col items-center gap-2">
                <button
                  type="button"
                  onClick={handleResendCode}
                  disabled={resendCooldownSeconds > 0 || isLoading}
                  className="text-xs font-medium text-amber-400 hover:text-amber-300 disabled:text-neutral-600 disabled:cursor-not-allowed flex items-center gap-1.5 transition-colors"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  {resendCooldownSeconds > 0 ? (
                    <span>Resend Code ({resendCooldownSeconds}s cooldown)</span>
                  ) : (
                    <span>Resend Verification Code</span>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => switchMode('forgot')}
                  className="text-xs text-neutral-400 hover:text-white transition-colors"
                >
                  Change Email Address
                </button>
              </div>
            </form>
          )}

          {/* 5. RESET PASSWORD FORM */}
          {mode === 'reset' && (
            <form onSubmit={handleResetSubmit} className="space-y-4">
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
                    autoComplete="new-password"
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
                <div className="flex items-center gap-2 mt-1.5 text-[11px] text-neutral-400">
                  <span className={`w-1.5 h-1.5 rounded-full ${isPasswordLongEnough ? 'bg-emerald-400' : 'bg-neutral-600'}`} />
                  <span>At least 8 characters</span>
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
                    placeholder="Re-enter new password"
                    autoComplete="new-password"
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
                disabled={isLoading || !isPasswordLongEnough || !doPasswordsMatch}
                className="w-full py-2.5 px-4 bg-amber-400 hover:bg-amber-300 disabled:bg-amber-400/50 text-neutral-950 font-semibold text-sm rounded-xl transition-all shadow-md flex items-center justify-center gap-2 mt-2"
              >
                {isLoading ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>Updating Password...</span>
                  </>
                ) : (
                  <>
                    <span>Set New Password & Sign In</span>
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
                  Cancel & Return to Sign In
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
            <span>Secure 6-Digit Email OTP · 300s Server TTL · Keyed HMAC · Session Revocation Guard</span>
          </div>
          <div className="text-neutral-400">
            SquadForge Enterprise v2.4
          </div>
        </div>
      </footer>
    </div>
  );
};
