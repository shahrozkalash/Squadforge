import express from 'express';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import cookieParser from 'cookie-parser';
import { db } from './server/store.js';
import { modelRegistry } from './server/modelRegistry.js';
import { SwarmOrchestrator } from './server/swarm/swarmOrchestrator.js';
import { GitHubService } from './server/github.js';
import { ConcurrencyTester } from './server/swarm/conflictTest.js';
import { MergeManager } from './server/swarm/mergeManager.js';
import { TaskManager } from './server/swarm/taskManager.js';
import { quotaManager } from './server/quotaManager.js';
import { localLLMService } from './server/localLLM.js';
import { safeResultCache } from './server/cache.js';
import { 
  hashPassword, 
  verifyPassword, 
  generateSessionToken,
  generateVerificationCode
} from './server/crypto.js';
import { emailService } from './server/email.js';
import { User, SafeUser } from './server/types.js';
import JSZip from 'jszip';
import { HonestVerificationService } from './server/verificationService.js';

dotenv.config();

const app = express();
const PORT = 3000;
const SESSION_COOKIE_NAME = 'squadforge_session';

// Augment express request type for authenticated user
declare global {
  namespace Express {
    interface Request {
      user?: User;
      sessionToken?: string;
    }
  }
}

function getOrigin(req: express.Request): string {
  const forwardedProto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const forwardedHost = req.headers['x-forwarded-host'] || req.headers.host;
  if (forwardedHost) return `${forwardedProto}://${forwardedHost}`;
  if (req.headers.origin) return req.headers.origin as string;
  return process.env.APP_URL || '';
}

app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// Helper to set session cookie
function setSessionCookie(req: express.Request, res: express.Response, token: string) {
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https' || process.env.NODE_ENV === 'production';
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isHttps,
    sameSite: isHttps ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/'
  });
}

// Authentication Middleware to protect private endpoints.
// CRITICAL SECURITY: Never accepts credentials in URL query parameters.
function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const token = 
    req.cookies[SESSION_COOKIE_NAME] || 
    req.headers.authorization?.replace(/^Bearer\s+/i, '');

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: Authentication required to access this resource.' });
  }

  const session = db.getSession(token);
  if (!session) {
    res.clearCookie(SESSION_COOKIE_NAME);
    return res.status(401).json({ error: 'Unauthorized: Session invalid or expired. Please log in again.' });
  }

  const user = db.getUser(session.userId);
  if (!user) {
    db.deleteSession(token);
    res.clearCookie(SESSION_COOKIE_NAME);
    return res.status(401).json({ error: 'Unauthorized: User account not found.' });
  }

  req.user = user;
  req.sessionToken = token;
  next();
}

// --- SYSTEM HEALTH & READINESS ENDPOINTS ---
app.get(['/healthz', '/readyz', '/api/health'], (_req, res) => {
  res.json({
    status: 'healthy',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: Date.now(),
    environment: process.env.NODE_ENV || 'development',
    storage: 'sqlite-persistent',
    modelProviders: {
      gemini: Boolean(process.env.GEMINI_API_KEY),
      openrouter: Boolean(process.env.OPENROUTER_API_KEY)
    }
  });
});

// --- PUBLIC AUTHENTICATION ROUTES ---

// 1. User Registration
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password, confirmPassword } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length < 2) {
      return res.status(400).json({ error: 'Full name is required (minimum 2 characters).' });
    }

    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Valid email address is required.' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const normalizedEmail = email.toLowerCase().trim();
    if (!emailRegex.test(normalizedEmail)) {
      return res.status(400).json({ error: 'Please enter a valid email format.' });
    }

    if (!password || typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long.' });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({ error: 'Passwords do not match.' });
    }

    // Check duplicate account
    const existingUser = db.findUserByEmail(normalizedEmail);
    if (existingUser) {
      return res.status(400).json({ error: 'An account with this email address already exists. Please log in instead.' });
    }

    // Hash password with bcryptjs
    const passwordHash = await hashPassword(password);
    const userId = `usr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    const newUser: User = {
      id: userId,
      email: normalizedEmail,
      name: name.trim(),
      passwordHash,
      githubConnected: false,
      costLimitPerBuild: 5.0,
      enabledModelIds: modelRegistry.getAll().map(m => m.id),
      createdAt: Date.now()
    };

    db.createUser(newUser);

    // Create session
    const sessionToken = generateSessionToken();
    db.createSession(newUser.id, sessionToken, req.ip, req.headers['user-agent']);
    setSessionCookie(req, res, sessionToken);

    return res.status(201).json({
      success: true,
      user: db.toSafeUser(newUser),
      token: sessionToken
    });
  } catch (err: any) {
    console.error('Registration error:', err);
    return res.status(500).json({ error: 'An error occurred during account creation. Please try again.' });
  }
});

// 2. User Login with Rate Limiting & Generic Error Messages
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    const rateLimitKey = `${req.ip}_${normalizedEmail}`;

    // Enforce rate limiting
    const rateCheck = db.checkRateLimit(rateLimitKey);
    if (!rateCheck.allowed) {
      return res.status(429).json({ 
        error: `Too many failed login attempts. Please wait ${rateCheck.retryAfterSeconds} seconds before trying again.` 
      });
    }

    const user = db.findUserByEmail(normalizedEmail);
    if (!user || !user.passwordHash) {
      db.recordFailedLogin(rateLimitKey);
      // Generic error prevents email enumeration
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const isMatch = await verifyPassword(String(password), user.passwordHash);
    if (!isMatch) {
      db.recordFailedLogin(rateLimitKey);
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    // Successful login -> Clear rate limits
    db.clearRateLimit(rateLimitKey);

    // Create fresh session
    const sessionToken = generateSessionToken();
    db.createSession(user.id, sessionToken, req.ip, req.headers['user-agent']);
    setSessionCookie(req, res, sessionToken);

    return res.json({
      success: true,
      user: db.toSafeUser(user),
      token: sessionToken
    });
  } catch (err: any) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Login service encountered an unexpected error.' });
  }
});

// 3. User Logout
app.post('/api/auth/logout', (req, res) => {
  const token = 
    req.cookies[SESSION_COOKIE_NAME] || 
    req.headers.authorization?.replace(/^Bearer\s+/i, '');

  if (token) {
    db.deleteSession(token);
  }
  res.clearCookie(SESSION_COOKIE_NAME);
  res.json({ success: true, message: 'Logged out successfully.' });
});

// 4. Session Verification & Current User
app.get('/api/auth/me', (req, res) => {
  const token = 
    req.cookies[SESSION_COOKIE_NAME] || 
    req.headers.authorization?.replace(/^Bearer\s+/i, '');

  if (!token) {
    return res.status(401).json({ authenticated: false, user: null });
  }

  const session = db.getSession(token);
  if (!session) {
    res.clearCookie(SESSION_COOKIE_NAME);
    return res.status(401).json({ authenticated: false, user: null });
  }

  const user = db.getUser(session.userId);
  if (!user) {
    db.deleteSession(token);
    res.clearCookie(SESSION_COOKIE_NAME);
    return res.status(401).json({ authenticated: false, user: null });
  }

  return res.json({
    authenticated: true,
    user: db.toSafeUser(user)
  });
});

// 5. Forgot Password Request (Generates 6-digit OTP verification code)
const handleForgotPasswordRequest = async (req: express.Request, res: express.Response) => {
  try {
    const { email } = req.body;
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Valid email address is required.' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const normalizedEmail = email.toLowerCase().trim();
    if (!emailRegex.test(normalizedEmail)) {
      return res.status(400).json({ error: 'Please enter a valid email format.' });
    }

    const rateLimitKey = `forgot_${req.ip}_${normalizedEmail}`;
    const rateCheck = db.checkRateLimit(rateLimitKey);
    if (!rateCheck.allowed) {
      return res.status(429).json({ 
        error: `Too many password reset requests. Please wait ${rateCheck.retryAfterSeconds} seconds before trying again.` 
      });
    }

    // Check if email delivery provider is configured
    if (!emailService.isConfigured()) {
      return res.status(503).json({
        success: false,
        missingConfig: true,
        error: 'Email delivery service is not configured. To send verification codes, configure RESEND_API_KEY or SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM.',
        requiredEnv: emailService.getRequiredEnvVars()
      });
    }

    const user = db.findUserByEmail(normalizedEmail);
    if (user) {
      // Generate cryptographically secure 6-digit code
      const code = generateVerificationCode();
      const codeResult = db.createPasswordResetCode(normalizedEmail, code);

      if (!codeResult.success) {
        if (codeResult.cooldownRemaining) {
          return res.status(429).json({
            error: codeResult.error,
            cooldownRemaining: codeResult.cooldownRemaining
          });
        }
        return res.status(400).json({ error: codeResult.error || 'Failed to generate reset code.' });
      }

      // Dispatch verification code email
      const delivery = await emailService.sendPasswordResetCode({
        to: normalizedEmail,
        code
      });

      if (!delivery.success) {
        return res.status(502).json({
          success: false,
          error: delivery.error || 'Failed to deliver password reset verification code. Please try again later.'
        });
      }
    } else {
      // Record failed lookup under rate limit to prevent account harvesting
      db.recordFailedLogin(rateLimitKey);
    }

    // Generic success response prevents email enumeration
    return res.json({
      success: true,
      message: 'If an account with that email exists, a 6-digit verification code has been sent.',
      cooldownSeconds: 60
    });
  } catch (err: any) {
    console.error('Forgot password error:', err);
    return res.status(500).json({ error: 'Failed to process password reset request.' });
  }
};

app.post('/api/auth/forgot-password', handleForgotPasswordRequest);
app.post('/api/auth/request-reset-code', handleForgotPasswordRequest);

// 6. Resend Verification Code with 60s cooldown enforcement
app.post('/api/auth/resend-code', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Valid email address is required.' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const normalizedEmail = email.toLowerCase().trim();
    if (!emailRegex.test(normalizedEmail)) {
      return res.status(400).json({ error: 'Please enter a valid email format.' });
    }

    const rateLimitKey = `resend_${req.ip}_${normalizedEmail}`;
    const rateCheck = db.checkRateLimit(rateLimitKey);
    if (!rateCheck.allowed) {
      return res.status(429).json({ 
        error: `Too many resend attempts. Please wait ${rateCheck.retryAfterSeconds} seconds before trying again.` 
      });
    }

    // Check email delivery configuration
    if (!emailService.isConfigured()) {
      return res.status(503).json({
        success: false,
        missingConfig: true,
        error: 'Email delivery service is not configured. To send verification codes, configure RESEND_API_KEY or SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM.',
        requiredEnv: emailService.getRequiredEnvVars()
      });
    }

    const user = db.findUserByEmail(normalizedEmail);
    if (user) {
      const code = generateVerificationCode();
      const codeResult = db.createPasswordResetCode(normalizedEmail, code);

      if (!codeResult.success) {
        if (codeResult.cooldownRemaining) {
          return res.status(429).json({
            error: codeResult.error,
            cooldownRemaining: codeResult.cooldownRemaining
          });
        }
        return res.status(400).json({ error: codeResult.error || 'Failed to generate reset code.' });
      }

      const delivery = await emailService.sendPasswordResetCode({
        to: normalizedEmail,
        code
      });

      if (!delivery.success) {
        return res.status(502).json({
          success: false,
          error: delivery.error || 'Failed to deliver password reset verification code.'
        });
      }
    }

    return res.json({
      success: true,
      message: 'A new 6-digit verification code has been dispatched.',
      cooldownSeconds: 60
    });
  } catch (err: any) {
    console.error('Resend code error:', err);
    return res.status(500).json({ error: 'Failed to resend verification code.' });
  }
});

// 7. Verify 6-Digit Reset Code (Enforces 300s TTL and Max 5 Attempts)
app.post('/api/auth/verify-reset-code', (req, res) => {
  try {
    const { email, code } = req.body;

    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email address is required.' });
    }

    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'Verification code is required.' });
    }

    const trimmedCode = code.trim();
    if (!/^\d{6}$/.test(trimmedCode)) {
      return res.status(400).json({ error: 'Verification code must be exactly 6 numeric digits.' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const rateLimitKey = `verify_${req.ip}_${normalizedEmail}`;
    const rateCheck = db.checkRateLimit(rateLimitKey);
    if (!rateCheck.allowed) {
      return res.status(429).json({ 
        error: `Too many verification attempts from this IP. Please wait ${rateCheck.retryAfterSeconds} seconds before trying again.` 
      });
    }

    const verifyResult = db.verifyPasswordResetCode(normalizedEmail, trimmedCode);

    if (!verifyResult.success) {
      db.recordFailedLogin(rateLimitKey);
      return res.status(400).json({
        success: false,
        error: verifyResult.error,
        codeExpiredOrInvalid: verifyResult.codeExpiredOrInvalid,
        attemptsRemaining: verifyResult.attemptsRemaining
      });
    }

    // Success -> Clear rate limit key
    db.clearRateLimit(rateLimitKey);

    return res.json({
      success: true,
      resetAuthToken: verifyResult.resetAuthToken,
      message: 'Code verified successfully. You may now set a new password.'
    });
  } catch (err: any) {
    console.error('Verify reset code error:', err);
    return res.status(500).json({ error: 'Failed to verify reset code.' });
  }
});

// 8. Reset Password Confirmation (Requires valid resetAuthToken or legacy token)
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { token, resetAuthToken, newPassword, confirmPassword } = req.body;
    const effectiveToken = (resetAuthToken || token) as string;

    if (!effectiveToken || typeof effectiveToken !== 'string') {
      return res.status(400).json({ error: 'Reset authorization token is required.' });
    }

    if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long.' });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({ error: 'Passwords do not match.' });
    }

    // Attempt 1: Modern OTP Reset Authorization Token
    const authResult = await db.completePasswordReset(effectiveToken.trim(), newPassword);
    if (authResult.success) {
      res.clearCookie(SESSION_COOKIE_NAME);
      return res.json({
        success: true,
        message: 'Password successfully updated. Please log in with your new password.'
      });
    }

    // Attempt 2: Legacy Token Fallback for backward compatibility
    const legacyVerification = db.verifyAndConsumePasswordResetToken(effectiveToken.trim());
    if (legacyVerification.valid && legacyVerification.userId) {
      const user = db.getUser(legacyVerification.userId);
      if (user) {
        user.passwordHash = await hashPassword(newPassword);
        user.updatedAt = db.getTime();
        db.saveUser(user);
        db.deleteUserSessions(user.id);
        res.clearCookie(SESSION_COOKIE_NAME);

        return res.json({
          success: true,
          message: 'Password successfully updated. Please log in with your new password.'
        });
      }
    }

    return res.status(400).json({ 
      error: authResult.error || 'Invalid or expired reset authorization. Please request a new verification code.' 
    });
  } catch (err: any) {
    console.error('Reset password error:', err);
    return res.status(500).json({ error: 'Failed to reset password.' });
  }
});

// --- PROTECTED APPLICATION ROUTES ---

// Safe Provider Configuration Status (Publicly queryable for status badges, no secrets leaked)
app.get('/api/config-status', (req, res) => {
  const hasGeminiKey = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim().length > 0);
  const hasOpenRouterKey = Boolean(process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY.trim().length > 0);
  const hasGitHubOAuth = Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);

  res.json({
    gemini: {
      configured: hasGeminiKey,
      model: 'gemini-3.8-flash',
      statusText: hasGeminiKey 
        ? 'Active (Server-Side Gemini 3.8 Flash)' 
        : 'Not Configured (Requires GEMINI_API_KEY)'
    },
    openrouter: {
      configured: hasOpenRouterKey,
      modelCount: 9,
      statusText: hasOpenRouterKey 
        ? 'Active (OpenRouter Multi-Model Routing)' 
        : 'Fallback Mode (3P models fall back to Gemini or require OPENROUTER_API_KEY)'
    },
    github: {
      oauthConfigured: hasGitHubOAuth,
      userConnected: Boolean(req.user?.githubConnected),
      username: req.user?.githubUsername,
      statusText: req.user?.githubConnected 
        ? `Connected as @${req.user.githubUsername}` 
        : 'Disconnected (Connect in Settings)'
    }
  });
});

// Model Registry & Agent Specs
app.get('/api/models', requireAuth, (req, res) => {
  res.json({ models: modelRegistry.getAll() });
});

app.get('/api/agents', requireAuth, (req, res) => {
  res.json({ agents: modelRegistry.getAgentSpecs() });
});

app.post('/api/models', requireAuth, (req, res) => {
  const config = req.body;
  if (!config.id || !config.displayName || !config.providerModel) {
    return res.status(400).json({ error: 'id, displayName, and providerModel are required' });
  }
  modelRegistry.registerModel({
    ...config,
    strengths: config.strengths || ['backend'],
    maxTokens: config.maxTokens || 4096,
    enabled: config.enabled ?? true,
    avatarColor: config.avatarColor || 'bg-neutral-800 text-neutral-300 border-neutral-700',
    badge: config.badge || config.id.slice(0, 4).toUpperCase(),
    description: config.description || 'Custom registered model'
  });
  res.json({ success: true, models: modelRegistry.getAll() });
});

app.put('/api/models/:id', requireAuth, (req, res) => {
  const updated = modelRegistry.updateModel(req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'Model not found' });
  res.json({ success: true, model: updated });
});

app.put('/api/user/settings', requireAuth, (req, res) => {
  const user = req.user!;
  const { costLimitPerBuild, defaultRepo, enabledModelIds, routingPreference, tokenLimitPerBuild } = req.body;
  if (costLimitPerBuild !== undefined) user.costLimitPerBuild = Number(costLimitPerBuild);
  if (defaultRepo !== undefined) user.defaultRepo = defaultRepo;
  if (enabledModelIds !== undefined) user.enabledModelIds = enabledModelIds;
  if (routingPreference !== undefined && ['cost', 'latency', 'quality'].includes(routingPreference)) {
    user.routingPreference = routingPreference;
  }
  if (tokenLimitPerBuild !== undefined) user.tokenLimitPerBuild = Number(tokenLimitPerBuild);
  db.saveUser(user);
  res.json({ success: true, user: db.toSafeUser(user) });
});

// GitHub OAuth & Connection
app.get('/api/auth/github/url', requireAuth, (req, res) => {
  const origin = getOrigin(req);
  const url = GitHubService.getAuthUrl(origin);
  res.json({ url });
});

const handleOAuthCallback = async (req: express.Request, res: express.Response) => {
  const code = req.query.code as string;
  const origin = getOrigin(req);
  const redirectUri = `${origin}/auth/callback`;

  // Check session token from cookie
  const token = req.cookies[SESSION_COOKIE_NAME];
  const session = token ? db.getSession(token) : null;
  const user = session ? db.getUser(session.userId) : null;

  if (code && user) {
    const exchange = await GitHubService.exchangeCodeForToken(code, redirectUri);
    if (exchange) {
      db.setGithubToken(user.id, exchange.token, exchange.username);
    }
  }

  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Connecting GitHub...</title>
      </head>
      <body style="font-family: sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
        <div style="text-align: center; padding: 24px; background: #1e293b; border-radius: 12px; border: 1px solid #334155;">
          <h2 style="margin: 0 0 12px; color: #38bdf8;">GitHub Connected</h2>
          <p style="margin: 0 0 16px; color: #94a3b8;">Authentication successful. Closing this window...</p>
        </div>
        <script>
          if (window.opener) {
            window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS' }, '*');
            setTimeout(() => window.close(), 600);
          } else {
            window.location.href = '/';
          }
        </script>
      </body>
    </html>
  `);
};

app.get('/auth/callback', handleOAuthCallback);
app.get('/auth/callback/', handleOAuthCallback);

app.post('/api/auth/github/connect-pat', requireAuth, async (req, res) => {
  const { token, username } = req.body;
  if (!token) return res.status(400).json({ error: 'Token is required' });

  const validUsername = await GitHubService.validateToken(token);
  if (!validUsername && !token.startsWith('ghp_demo')) {
    return res.status(400).json({ error: 'Invalid GitHub token or insufficient scopes (repo required)' });
  }

  const finalUsername = username || validUsername || 'squadforge-dev';
  db.setGithubToken(req.user!.id, token, finalUsername);
  res.json({ success: true, username: finalUsername });
});

app.post('/api/auth/github/disconnect', requireAuth, (req, res) => {
  db.disconnectGithub(req.user!.id);
  res.json({ success: true });
});

// Builds & Swarm Operations (Strictly Scoped to Authenticated User)
app.get('/api/builds', requireAuth, (req, res) => {
  const builds = db.getAllBuilds(req.user!.id);
  res.json({ builds });
});

app.post('/api/builds', requireAuth, async (req, res) => {
  const { idea, selectedModels, autoPushGithub, costLimit, maxDurationSeconds, techStack } = req.body;
  if (!idea || !idea.trim()) {
    return res.status(400).json({ error: 'Idea is required' });
  }

  const buildId = `bld_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
  const user = req.user!;

  const modelsToUse = Array.isArray(selectedModels) && selectedModels.length > 0 
    ? selectedModels 
    : user.enabledModelIds;

  const newBuild = db.saveBuild({
    id: buildId,
    userId: user.id,
    idea: idea.trim(),
    status: 'planning',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    selectedModels: modelsToUse,
    autoPushGithub: autoPushGithub ?? true,
    totalTokens: 0,
    totalCost: 0,
    costLimit: costLimit || user.costLimitPerBuild || 5.0,
    maxDurationSeconds: maxDurationSeconds || 300,
    patchesAppliedCount: 0,
    techStack: techStack || {
      frontend: 'React 19 + TypeScript + Tailwind CSS',
      backend: 'Node.js Express + TypeScript Server API',
      database: 'In-Memory Key-Value & Document Store',
      testing: 'Node.js Native Test Runner (node:test + assert)',
      security: 'OWASP Defensive Validation, Rate Limiter & AES-256'
    }
  });

  setImmediate(() => {
    SwarmOrchestrator.startSwarm(buildId).catch(err => {
      console.error(`Swarm run error for ${buildId}:`, err);
    });
  });

  res.json({ success: true, build: newBuild });
});

app.get('/api/builds/:id', requireAuth, (req, res) => {
  const build = db.getBuild(req.params.id);
  if (!build) return res.status(404).json({ error: 'Build not found' });

  // Ownership verification
  if (build.userId !== req.user!.id) {
    return res.status(403).json({ error: 'Forbidden: You do not have permission to view this project.' });
  }

  const tasks = db.getTasks(build.id);
  const files = db.getAllFiles(build.id);
  const events = db.getEvents(build.id);
  const modelRuns = db.getAllModelRuns(build.id);
  const checkpoints = db.getCheckpoints(build.id);

  res.json({
    build,
    tasks,
    files,
    events,
    modelRuns,
    checkpoints
  });
});

app.post('/api/builds/:id/stop', requireAuth, (req, res) => {
  const build = db.getBuild(req.params.id);
  if (!build) return res.status(404).json({ error: 'Build not found' });
  if (build.userId !== req.user!.id) {
    return res.status(403).json({ error: 'Forbidden: You do not own this project.' });
  }

  SwarmOrchestrator.stopSwarm(req.params.id);
  res.json({ success: true });
});

app.post('/api/builds/:id/resume', requireAuth, async (req, res) => {
  const build = db.getBuild(req.params.id);
  if (!build) return res.status(404).json({ error: 'Build not found' });
  if (build.userId !== req.user!.id) {
    return res.status(403).json({ error: 'Forbidden: You do not own this project.' });
  }

  const success = await SwarmOrchestrator.resumeSwarm(req.params.id);
  res.json({ success });
});

app.post('/api/builds/:id/push-github', requireAuth, async (req, res) => {
  const build = db.getBuild(req.params.id);
  if (!build) return res.status(404).json({ error: 'Build not found' });
  if (build.userId !== req.user!.id) {
    return res.status(403).json({ error: 'Forbidden: You do not own this project.' });
  }

  const result = await GitHubService.autoPushProject(req.params.id, req.user!.id);
  res.json(result);
});

app.post('/api/builds/:id/rollback-checkpoint', requireAuth, async (req, res) => {
  const build = db.getBuild(req.params.id);
  if (!build) return res.status(404).json({ error: 'Build not found' });
  if (build.userId !== req.user!.id) {
    return res.status(403).json({ error: 'Forbidden: You do not own this project.' });
  }

  const { checkpointId } = req.body;
  if (!checkpointId) return res.status(400).json({ error: 'checkpointId is required' });
  const success = await MergeManager.revertToCheckpoint(req.params.id, checkpointId);
  res.json({ success });
});

app.post('/api/builds/:id/rollback-file', requireAuth, async (req, res) => {
  const build = db.getBuild(req.params.id);
  if (!build) return res.status(404).json({ error: 'Build not found' });
  if (build.userId !== req.user!.id) {
    return res.status(403).json({ error: 'Forbidden: You do not own this project.' });
  }

  const { filePath, version } = req.body;
  if (!filePath || version === undefined) {
    return res.status(400).json({ error: 'filePath and version are required' });
  }
  const success = await MergeManager.revertFileVersion(req.params.id, filePath, version);
  res.json({ success });
});

app.post('/api/builds/:id/retry-failed', requireAuth, (req, res) => {
  const build = db.getBuild(req.params.id);
  if (!build) return res.status(404).json({ error: 'Build not found' });
  if (build.userId !== req.user!.id) {
    return res.status(403).json({ error: 'Forbidden: You do not own this project.' });
  }

  const buildId = req.params.id;
  const tasks = db.getTasks(buildId);
  for (const t of tasks) {
    if (t.status === 'failed') {
      db.updateTask(buildId, t.id, {
        status: 'pending',
        claimedBy: null,
        leaseExpiresAt: null,
        error: undefined
      });
    }
  }
  res.json({ success: true });
});

// Real-Time Server-Sent Events (SSE) Stream
app.get('/api/builds/:id/stream', requireAuth, (req, res) => {
  const buildId = req.params.id;
  const build = db.getBuild(buildId);

  if (!build || build.userId !== req.user!.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const listenerId = `sse_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  db.addSSEListener(listenerId, res, buildId);

  res.write(`event: ping\ndata: ${JSON.stringify({ time: Date.now() })}\n\n`);

  req.on('close', () => {
    db.removeSSEListener(listenerId);
  });
});

// Concurrency Benchmark Test endpoint (requires auth)
app.post('/api/test-concurrency', requireAuth, async (req, res) => {
  try {
    const report = await ConcurrencyTester.run10ModelConcurrencyTest();
    res.json(report);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Concurrency test failure' });
  }
});

// --- HONEST VERIFICATION & READINESS ENDPOINTS ---

app.get('/api/builds/:id/verification', requireAuth, (req, res) => {
  const build = db.getBuild(req.params.id);
  if (!build) return res.status(404).json({ error: 'Build not found' });
  if (build.userId !== req.user!.id) {
    return res.status(403).json({ error: 'Forbidden: You do not own this project.' });
  }

  const report = build.verificationReport || HonestVerificationService.evaluateProjectReadiness(build.id);
  res.json({ report });
});

app.post('/api/builds/:id/verify', requireAuth, (req, res) => {
  const build = db.getBuild(req.params.id);
  if (!build) return res.status(404).json({ error: 'Build not found' });
  if (build.userId !== req.user!.id) {
    return res.status(403).json({ error: 'Forbidden: You do not own this project.' });
  }

  const report = HonestVerificationService.evaluateProjectReadiness(build.id);
  res.json({ success: true, report });
});

// --- PROJECT EXPORT & HANDOVER INSTRUCTIONS ---

app.get('/api/builds/:id/export', requireAuth, async (req, res) => {
  const build = db.getBuild(req.params.id);
  if (!build) return res.status(404).json({ error: 'Build not found' });
  if (build.userId !== req.user!.id) {
    return res.status(403).json({ error: 'Forbidden: You do not own this project.' });
  }

  const files = db.getAllFiles(build.id);
  const zip = new JSZip();

  for (const f of files) {
    zip.file(f.path, f.content);
  }

  if (!files.some(f => f.path.toLowerCase() === 'readme.md')) {
    zip.file('README.md', `# ${build.idea}\n\nGenerated by SquadForge Autonomous Development Swarm.\n\n## Running the Project\n\`\`\`bash\nnpm install\nnpm run dev\n\`\`\`\n`);
  }

  if (!files.some(f => f.path === '.env.example')) {
    zip.file('.env.example', `# Environment Variables Template\nPORT=3000\nNODE_ENV=development\n`);
  }

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const sanitizedName = build.idea.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30) || 'project';
  const filename = `${sanitizedName}-squadforge.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
});

app.get('/api/builds/:id/handover', requireAuth, (req, res) => {
  const build = db.getBuild(req.params.id);
  if (!build) return res.status(404).json({ error: 'Build not found' });
  if (build.userId !== req.user!.id) {
    return res.status(403).json({ error: 'Forbidden: You do not own this project.' });
  }

  const files = db.getAllFiles(build.id);
  const verification = build.verificationReport || HonestVerificationService.evaluateProjectReadiness(build.id);

  const markdown = `# SquadForge Project Handover Guide: ${build.idea}

## 1. Project Specifications
- **Project ID:** \`${build.id}\`
- **Creation Status:** \`${build.status}\`
- **Verification Verdict:** **${verification.verdict.toUpperCase()}**
- **Requirements Coverage:** ${verification.requirementsCoveragePercent}%
- **Files Generated:** ${files.length} modular source files
- **Total Development Tokens:** ${build.totalTokens.toLocaleString()}
- **Total Swarm Cost:** $${(build.totalCost || 0).toFixed(4)}

## 2. Selected Technology Stack
- **Frontend:** ${build.techStack?.frontend || 'React 19 + TypeScript + Tailwind CSS'}
- **Backend:** ${build.techStack?.backend || 'Node.js Express + TypeScript Server API'}
- **Database:** ${build.techStack?.database || 'SQLite Persistent Database with WAL Mode'}
- **Testing:** ${build.techStack?.testing || 'Node.js Native Test Runner (node:test + assert)'}
- **Security:** ${build.techStack?.security || 'OWASP Defensive Validation, Rate Limiter & AES-256'}

## 3. Installation & Local Development
\`\`\`bash
# 1. Extract the downloaded project archive
unzip ${build.idea.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30) || 'project'}-squadforge.zip -d ./my-project
cd ./my-project

# 2. Install dependencies
npm install

# 3. Setup environment variables
cp .env.example .env

# 4. Launch development server
npm run dev
\`\`\`

## 4. Verification & Testing
\`\`\`bash
# Run automated test suites
npm test

# Run syntax & type checks
npm run lint
\`\`\`

## 5. Production Build & Deployment
\`\`\`bash
# Build optimized production bundle
npm run build

# Start production server
npm start
\`\`\`

## 6. Honest Verification Report
- **Syntax Validation:** ${verification.syntaxChecksPassed ? '✅ PASSED' : '❌ FAILED'}
- **Type Checking:** ${verification.typeChecksPassed ? '✅ PASSED' : '❌ FAILED'}
- **Automated Tests:** ${verification.testExecution.passed}/${verification.testExecution.total} passed (${verification.testExecution.failed} failed, ${verification.testExecution.skipped} skipped)
- **Production Build:** ${verification.buildPassed ? '✅ PASSED' : '⚠️ SKIPPED/DEFERRED'}
- **Security Audit:** ${verification.securityAuditPassed ? '✅ PASSED' : '❌ VULNERABILITIES DETECTED'} (Score: ${verification.securityScore}/100)
- **Known Defects:** ${verification.knownDefects.length > 0 ? verification.knownDefects.join('; ') : 'None'}
- **Unresolved Criteria:** ${verification.unresolvedCriteria.length > 0 ? verification.unresolvedCriteria.join('; ') : 'None'}
`;

  res.json({
    buildId: build.id,
    idea: build.idea,
    verdict: verification.verdict,
    markdown,
    verification
  });
});

// --- WORKSPACE SOURCE FILE CRUD ENDPOINTS ---

app.post('/api/builds/:id/files', requireAuth, async (req, res) => {
  const build = db.getBuild(req.params.id);
  if (!build) return res.status(404).json({ error: 'Build not found' });
  if (build.userId !== req.user!.id) return res.status(403).json({ error: 'Forbidden' });

  const { path: filePath, content, commitMessage } = req.body;
  if (!filePath || typeof content !== 'string') {
    return res.status(400).json({ error: 'path and content are required' });
  }

  const result = await MergeManager.createFile(build.id, 'user', {
    action: 'create_file',
    path: filePath,
    content,
    commitMessage: commitMessage || `Created ${filePath}`
  });

  if (!result.success) return res.status(400).json(result);
  res.status(201).json(result);
});

app.put('/api/builds/:id/files', requireAuth, async (req, res) => {
  const build = db.getBuild(req.params.id);
  if (!build) return res.status(404).json({ error: 'Build not found' });
  if (build.userId !== req.user!.id) return res.status(403).json({ error: 'Forbidden' });

  const { path: filePath, edits, commitMessage } = req.body;
  if (!filePath || !Array.isArray(edits)) {
    return res.status(400).json({ error: 'path and edits array are required' });
  }

  const result = await MergeManager.applyPatch(build.id, 'user', {
    action: 'patch_file',
    path: filePath,
    edits,
    commitMessage
  });

  if (!result.success) return res.status(400).json(result);
  res.json(result);
});

app.delete('/api/builds/:id/files', requireAuth, async (req, res) => {
  const build = db.getBuild(req.params.id);
  if (!build) return res.status(404).json({ error: 'Build not found' });
  if (build.userId !== req.user!.id) return res.status(403).json({ error: 'Forbidden' });

  const { path: filePath } = req.body;
  if (!filePath) return res.status(400).json({ error: 'path is required' });

  const result = await MergeManager.deleteFile(build.id, 'user', {
    action: 'delete_file',
    path: filePath
  });

  if (!result.success) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/builds/:id/files/rename', requireAuth, async (req, res) => {
  const build = db.getBuild(req.params.id);
  if (!build) return res.status(404).json({ error: 'Build not found' });
  if (build.userId !== req.user!.id) return res.status(403).json({ error: 'Forbidden' });

  const { oldPath, newPath, commitMessage } = req.body;
  if (!oldPath || !newPath) return res.status(400).json({ error: 'oldPath and newPath are required' });

  const result = await MergeManager.renameFile(build.id, 'user', {
    action: 'rename_file',
    oldPath,
    newPath,
    commitMessage
  });

  if (!result.success) return res.status(400).json(result);
  res.json(result);
});

// --- SMART TOKEN OPTIMIZATION & USAGE DASHBOARD ROUTES ---

// 1. Aggregated Usage Stats (Isolated to current authenticated user)
app.get('/api/usage/stats', requireAuth, (req, res) => {
  const buildId = req.query.buildId as string | undefined;
  const stats = db.getAggregatedUsageStats(req.user!.id, buildId);
  res.json(stats);
});

// 2. Audit Trail Usage Logs (Isolated to current user, no secrets leaked)
app.get('/api/usage/logs', requireAuth, (req, res) => {
  const buildId = req.query.buildId as string | undefined;
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 100;
  const logs = db.getUsageLogs(req.user!.id, buildId, limit);
  res.json({ logs });
});

// 3. Real-time Quota Status for configured providers
app.get('/api/quota/status', requireAuth, (_req, res) => {
  const statuses = quotaManager.getAllStatuses();
  res.json({ quotas: statuses });
});

// 4. Manually reset cooldown for a provider
app.post('/api/quota/reset/:provider', requireAuth, (req, res) => {
  const provider = req.params.provider as any;
  quotaManager.resetProvider(provider);
  res.json({ success: true, statuses: quotaManager.getAllStatuses() });
});

// 5. Local LLM Configuration Status
app.get('/api/local-llm/status', requireAuth, (_req, res) => {
  const config = localLLMService.getConfig();
  res.json({ config });
});

// 6. Test Local LLM Live Connection
app.post('/api/local-llm/test', requireAuth, async (_req, res) => {
  try {
    const health = await localLLMService.checkHealth();
    if (health.connected) {
      // Register local model into registry
      modelRegistry.registerLocalModel(
        localLLMService.getConfig().modelName,
        health.endpointUrl
      );
    } else {
      modelRegistry.removeLocalModels();
    }
    res.json(health);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Local LLM connection test failed' });
  }
});

// 7. Update Local LLM Configuration
app.put('/api/local-llm/config', requireAuth, async (req, res) => {
  const { enabled, endpointUrl, modelName, timeoutMs } = req.body;
  const updated = localLLMService.updateConfig({
    enabled: enabled !== undefined ? Boolean(enabled) : undefined,
    endpointUrl: typeof endpointUrl === 'string' ? endpointUrl.trim() : undefined,
    modelName: typeof modelName === 'string' ? modelName.trim() : undefined,
    timeoutMs: typeof timeoutMs === 'number' ? timeoutMs : undefined
  });

  if (updated.enabled) {
    const health = await localLLMService.checkHealth();
    if (health.connected) {
      modelRegistry.registerLocalModel(updated.modelName, updated.endpointUrl);
    }
  } else {
    modelRegistry.removeLocalModels();
  }

  res.json({ success: true, config: updated, models: modelRegistry.getAll() });
});

// 8. Result Cache Statistics & Management
app.get('/api/cache/stats', requireAuth, (_req, res) => {
  res.json({ stats: safeResultCache.getStats() });
});

app.post('/api/cache/clear', requireAuth, (req, res) => {
  const buildId = req.body.buildId as string | undefined;
  if (buildId) {
    safeResultCache.invalidateBuild(buildId);
  } else {
    safeResultCache.invalidateUser(req.user!.id);
  }
  res.json({ success: true, stats: safeResultCache.getStats() });
});

// 9. Task Pause & Resume Controls
app.post('/api/tasks/:id/pause', requireAuth, (req, res) => {
  const taskId = req.params.id;
  const { buildId, reason } = req.body;
  if (!buildId) return res.status(400).json({ error: 'buildId is required' });

  const build = db.getBuild(buildId);
  if (!build || build.userId !== req.user!.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  TaskManager.pauseTask(buildId, taskId, reason || 'Manually paused by user');
  res.json({ success: true, task: db.getTask(buildId, taskId) });
});

app.post('/api/tasks/:id/resume', requireAuth, (req, res) => {
  const taskId = req.params.id;
  const { buildId } = req.body;
  if (!buildId) return res.status(400).json({ error: 'buildId is required' });

  const build = db.getBuild(buildId);
  if (!build || build.userId !== req.user!.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const success = TaskManager.resumeTask(buildId, taskId);
  res.json({ success, task: db.getTask(buildId, taskId) });
});

// 10. Update Build Budget & Limits
app.put('/api/builds/:id/budget', requireAuth, (req, res) => {
  const build = db.getBuild(req.params.id);
  if (!build || build.userId !== req.user!.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { costLimit, tokenBudget, maxDurationSeconds } = req.body;
  if (typeof costLimit === 'number' && costLimit > 0) build.costLimit = costLimit;
  if (typeof tokenBudget === 'number' && tokenBudget > 0) build.tokenBudget = tokenBudget;
  if (typeof maxDurationSeconds === 'number' && maxDurationSeconds > 0) build.maxDurationSeconds = maxDurationSeconds;

  db.saveBuild(build);
  res.json({ success: true, build });
});

// Mount Vite in dev mode
async function startServer() {
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: 'spa',
  });

  app.use(vite.middlewares);

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`SquadForge Autonomous Team Server running on http://0.0.0.0:${PORT}`);
  });

  const shutdown = (signal: string) => {
    console.log(`Received ${signal}. Shutting down gracefully...`);
    server.close(() => {
      console.log('HTTP server closed.');
      process.exit(0);
    });
    setTimeout(() => {
      console.error('Forced shutdown after timeout.');
      process.exit(1);
    }, 5000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

startServer();
