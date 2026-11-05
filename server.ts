import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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
import { ExecutionAdapter } from './server/swarm/executionAdapter.js';
import { PreviewGenerator } from './server/swarm/previewGenerator.js';
import { ProjectMemoryService } from './server/swarm/projectMemory.js';
import { TechnologyStackRegistry } from './server/architecture/techRegistry.js';
import { SoftwareRequirementsAnalyzer } from './server/architecture/requirementsAnalyzer.js';
import { IntelligentStackSelector } from './server/architecture/stackSelector.js';
import { ProjectComplexityEstimator } from './server/architecture/complexityEstimator.js';
import { CollaborationManager } from './server/swarm/collaborationManager.js';
import { CodeReviewEngine } from './server/swarm/codeReviewEngine.js';
import { PatchValidationPipeline } from './server/swarm/patchValidationPipeline.js';
import { AIChallengeEngine } from './server/swarm/aiChallengeEngine.js';
import { CollaborativeDebuggingEngine } from './server/swarm/collaborativeDebuggingEngine.js';
import { ApprovalGateService } from './server/swarm/approvalGateService.js';
import { executionManager, previewService, startExecutionServices } from './server/execution/index.js';
import { repairCoordinator } from './server/debugging/index.js';
import { createDebuggingRouter } from './server/debugging/debuggingRoutes.js';
import { createExecutionRouter } from './server/execution/executionRoutes.js';
import { SharedWorkspaceService } from './server/swarm/sharedWorkspaceService.js';
import { CodeGenerationEngine } from './server/swarm/codeGenerationEngine.js';
import { GenerationProfileRegistry } from './server/swarm/generationProfiles.js';
import { ProjectContextEngine } from './server/swarm/projectContextEngine.js';
import { ContractFirstEngine } from './server/swarm/contractFirstEngine.js';

dotenv.config();

const app = express();

function resolvePort(): number {
  const portArgIndex = process.argv.indexOf('--port');
  if (portArgIndex !== -1 && process.argv[portArgIndex + 1]) {
    const val = parseInt(process.argv[portArgIndex + 1], 10);
    if (!isNaN(val) && val > 0) return val;
  }
  return 3000;
}

const PORT = resolvePort();
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
  return GitHubService.getTrustedOrigin(req);
}

// Defense-in-depth HTTP security headers
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // Allow framing within AI Studio and verified deployment origins
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self' https://*.google.com https://*.run.app https://ais.dev;");
  next();
});

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

// Helper to retrieve existing session or automatically issue an isolated guest session
function resolveUser(req: express.Request, res: express.Response): User {
  const token = 
    req.cookies[SESSION_COOKIE_NAME] || 
    req.headers.authorization?.replace(/^Bearer\s+/i, '');

  if (token) {
    const session = db.getSession(token);
    if (session) {
      const user = db.getUser(session.userId);
      if (user) {
        req.user = user;
        req.sessionToken = token;
        return user;
      }
    }
  }

  // Create isolated public guest user and session
  const guestHex = crypto.randomBytes(8).toString('hex');
  const guestId = `guest_${Date.now()}_${guestHex}`;
  const guestUser: User = {
    id: guestId,
    email: `guest-${guestHex.slice(0, 8)}@squadforge.local`,
    name: 'Guest Developer',
    githubConnected: false,
    costLimitPerBuild: 2.0, // Abuse prevention: reasonable cost cap for anonymous execution
    enabledModelIds: modelRegistry.getAll().map(m => m.id),
    createdAt: db.getTime(),
    isAnonymous: true
  };

  db.saveUser(guestUser);
  const sessionToken = generateSessionToken();
  db.createSession(guestUser.id, sessionToken, req.ip, req.headers['user-agent']);
  setSessionCookie(req, res, sessionToken);

  req.user = guestUser;
  req.sessionToken = sessionToken;
  return guestUser;
}

// Session Middleware: ensures an authentic or scoped guest session exists
// CRITICAL SECURITY: Protects multi-tenant boundaries while allowing frictionless public access
function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!req.user) {
    resolveUser(req, res);
  }
  next();
}

// --- SYSTEM HEALTH & READINESS ENDPOINTS ---

// Liveness probe: verifies process is responding
app.get('/healthz', (_req, res) => {
  res.json({
    status: 'healthy',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: Date.now()
  });
});

// Truthful readiness probe: verifies database storage is accessible and writable
app.get('/readyz', (_req, res) => {
  const storageHealth = db.checkHealth();
  if (!storageHealth.healthy) {
    return res.status(503).json({
      status: 'unready',
      error: storageHealth.error || 'Database storage is unavailable',
      timestamp: Date.now()
    });
  }
  res.json({
    status: 'ready',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: Date.now(),
    environment: process.env.NODE_ENV || 'development',
    storage: 'sqlite-persistent'
  });
});

// Detailed system health diagnostics
app.get('/api/health', (_req, res) => {
  const storageHealth = db.checkHealth();
  const statusCode = storageHealth.healthy ? 200 : 503;
  res.status(statusCode).json({
    status: storageHealth.healthy ? 'healthy' : 'degraded',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: Date.now(),
    environment: process.env.NODE_ENV || 'development',
    storage: storageHealth.healthy ? 'sqlite-persistent' : 'error',
    databaseError: storageHealth.error,
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

// 4. Session Verification & Current User (Allows immediate public guest access)
app.get('/api/auth/me', (req, res) => {
  const user = resolveUser(req, res);
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

// The model registry is shared by every user, so guests cannot change it in production
const requireModelEditor: express.RequestHandler = (req, res, next) => {
  if (process.env.NODE_ENV !== 'production') return next();
  const isGuest = req.user?.isAnonymous || req.user?.id.startsWith('guest_');
  if (isGuest) {
    return res.status(403).json({ error: 'Guest sessions cannot change shared models.' });
  }
  const admins = (process.env.MODEL_ADMIN_USER_IDS || '').split(',').map(id => id.trim()).filter(Boolean);
  if (!admins.includes(req.user!.id)) {
    return res.status(403).json({ error: 'Only a model administrator can change shared models.' });
  }
  next();
};

app.post('/api/models', requireAuth, requireModelEditor, (req, res) => {
  const config = req.body;
  if (!config.id || !config.displayName || !config.providerModel) {
    return res.status(400).json({ error: 'id, displayName, and providerModel are required' });
  }
  // MergeManager exempts these actors from approval checks
  if (['system', 'user'].includes(String(config.id).trim().toLowerCase())) {
    return res.status(400).json({ error: `The model id "${config.id}" is reserved` });
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

app.put('/api/models/:id', requireAuth, requireModelEditor, (req, res) => {
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

function sanitizeTargetOrigin(origin: string): string {
  if (!origin || origin.trim() === '*' || typeof origin !== 'string') {
    return 'http://127.0.0.1:3000';
  }
  try {
    const u = new URL(origin);
    return `${u.protocol}//${u.host}`;
  } catch {
    return 'http://127.0.0.1:3000';
  }
}

// GitHub OAuth & Connection
function renderOAuthSuccessHtml(targetOrigin: string, username: string): string {
  const safeUsername = username.replace(/[^\w-]/g, '');
  const exactOrigin = sanitizeTargetOrigin(targetOrigin);
  return `<!DOCTYPE html>
<html>
  <head>
    <title>GitHub Connected - SquadForge</title>
    <meta charset="utf-8">
  </head>
  <body style="font-family: sans-serif; background: #0a0a0a; color: #f5f5f5; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
    <div style="text-align: center; padding: 32px; background: #171717; border-radius: 16px; border: 1px solid #262626; max-width: 420px; box-shadow: 0 10px 25px rgba(0,0,0,0.5);">
      <div style="display: inline-block; width: 44px; height: 44px; line-height: 44px; background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.3); border-radius: 12px; font-size: 20px; color: #10b981; margin-bottom: 16px;">
        ✓
      </div>
      <h2 style="margin: 0 0 8px; color: #10b981; font-size: 18px;">GitHub Connected</h2>
      <p style="margin: 0 0 16px; color: #a3a3a3; font-size: 13px;">Authentication successful as <strong>@${safeUsername}</strong>. Closing window...</p>
    </div>
    <script>
      (function() {
        var target = ${JSON.stringify(exactOrigin)};
        if (window.opener) {
          try {
            window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS', username: ${JSON.stringify(safeUsername)} }, target);
          } catch(e) {}
          setTimeout(function() { window.close(); }, 600);
        } else {
          window.location.href = '/';
        }
      })();
    </script>
  </body>
</html>`;
}

function renderOAuthErrorHtml(targetOrigin: string, errorText: string): string {
  const safeError = errorText.replace(/[<>"]/g, '');
  const exactOrigin = sanitizeTargetOrigin(targetOrigin);
  return `<!DOCTYPE html>
<html>
  <head>
    <title>GitHub Connection Failed - SquadForge</title>
    <meta charset="utf-8">
  </head>
  <body style="font-family: sans-serif; background: #0a0a0a; color: #f5f5f5; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
    <div style="text-align: center; padding: 32px; background: #171717; border-radius: 16px; border: 1px solid #e11d48; max-width: 420px; box-shadow: 0 10px 25px rgba(0,0,0,0.5);">
      <div style="display: inline-block; width: 44px; height: 44px; line-height: 44px; background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3); border-radius: 12px; font-size: 20px; color: #ef4444; margin-bottom: 16px;">
        ✕
      </div>
      <h2 style="margin: 0 0 8px; color: #f43f5e; font-size: 18px;">GitHub Connection Failed</h2>
      <p style="margin: 0 0 20px; color: #a3a3a3; font-size: 13px;">${safeError}</p>
      <button onclick="window.close()" style="background: #262626; color: #e5e5e5; border: 1px solid #404040; padding: 8px 20px; border-radius: 8px; font-size: 12px; cursor: pointer;">Close Window</button>
    </div>
    <script>
      (function() {
        var target = ${JSON.stringify(exactOrigin)};
        if (window.opener) {
          try {
            window.opener.postMessage({ type: 'OAUTH_AUTH_FAILURE', error: ${JSON.stringify(safeError)} }, target);
          } catch(e) {}
          setTimeout(function() { window.close(); }, 2500);
        }
      })();
    </script>
  </body>
</html>`;
}

// GitHub OAuth & Connection
app.get('/api/auth/github/url', requireAuth, (req, res) => {
  if (process.env.NODE_ENV === 'production' && !GitHubService.hasValidConfiguredAppUrl()) {
    return res.status(500).json({ 
      error: 'Production OAuth requires an explicitly configured, trusted APP_URL (e.g. https://squadforge.example.com). Request rejected to prevent host header poisoning.' 
    });
  }
  const origin = GitHubService.getTrustedOrigin(req);
  const redirectUri = `${origin}/auth/callback`;
  const state = GitHubService.generateOAuthState(req.user!.id, req.sessionToken!, redirectUri);
  const url = GitHubService.getAuthUrl(redirectUri, state);
  res.json({ url, state });
});

const handleOAuthCallback = async (req: express.Request, res: express.Response) => {
  const code = typeof req.query.code === 'string' ? req.query.code.trim() : '';
  const state = typeof req.query.state === 'string' ? req.query.state.trim() : '';
  const oauthError = typeof req.query.error === 'string' ? req.query.error : undefined;

  const trustedOrigin = GitHubService.getTrustedOrigin(req);
  const sessionToken = 
    req.cookies[SESSION_COOKIE_NAME] || 
    req.headers.authorization?.replace(/^Bearer\s+/i, '');

  // 1. Handle GitHub user cancellation or error
  if (oauthError) {
    return res.status(400).send(renderOAuthErrorHtml(trustedOrigin, 'GitHub authorization was denied or canceled.'));
  }

  // 2. Reject missing code
  if (!code) {
    return res.status(400).send(renderOAuthErrorHtml(trustedOrigin, 'Missing authorization code from GitHub callback.'));
  }

  // 3. Reject missing state parameter
  if (!state) {
    return res.status(400).send(renderOAuthErrorHtml(trustedOrigin, 'Missing OAuth state parameter. Request rejected to prevent CSRF.'));
  }

  // 4. Reject if no active browser session
  if (!sessionToken) {
    return res.status(401).send(renderOAuthErrorHtml(trustedOrigin, 'No active browser session detected. Please log in before connecting GitHub.'));
  }

  // 5. Strictly validate and single-use consume state BEFORE token exchange
  const stateValidation = GitHubService.validateAndConsumeOAuthState(state, sessionToken);
  if (!stateValidation.valid || !stateValidation.record) {
    return res.status(403).send(renderOAuthErrorHtml(trustedOrigin, stateValidation.error || 'Invalid, expired, or session-mismatched OAuth state.'));
  }

  const { userId, redirectUri } = stateValidation.record;
  const user = db.getUser(userId);
  if (!user) {
    return res.status(404).send(renderOAuthErrorHtml(trustedOrigin, 'Authenticated user profile not found.'));
  }

  // 6. Exchange code for access token using the exact registered redirectUri from authorization
  const exchange = await GitHubService.exchangeCodeForToken(code, redirectUri);
  if (!exchange || !exchange.token || !exchange.username) {
    return res.status(502).send(renderOAuthErrorHtml(trustedOrigin, 'Failed to complete authentication with GitHub. Code may be invalid or expired.'));
  }

  // 7. Securely store encrypted token with authentic username
  db.setGithubToken(user.id, exchange.token, exchange.username);

  // 8. Render success page with restricted postMessage target origin (NO wildcard '*')
  return res.send(renderOAuthSuccessHtml(trustedOrigin, exchange.username));
};

app.get('/auth/callback', handleOAuthCallback);
app.get('/auth/callback/', handleOAuthCallback);

app.post('/api/auth/github/connect-pat', requireAuth, async (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string' || !token.trim()) {
    return res.status(400).json({ error: 'Personal Access Token is required' });
  }

  const cleanToken = token.trim();
  const validUsername = await GitHubService.validateToken(cleanToken);
  if (!validUsername) {
    return res.status(400).json({ error: 'Invalid GitHub token or insufficient scopes (repo scope required)' });
  }

  // Real verified username from GitHub API
  db.setGithubToken(req.user!.id, cleanToken, validUsername);
  res.json({ success: true, username: validUsername });
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
  const { idea, selectedModels, autoPushGithub, costLimit, maxDurationSeconds, techStack, projectType } = req.body;
  if (!idea || !idea.trim()) {
    return res.status(400).json({ error: 'Idea is required' });
  }

  const buildId = `bld_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
  const user = req.user!;

  const modelsToUse = Array.isArray(selectedModels) && selectedModels.length > 0 
    ? selectedModels 
    : user.enabledModelIds;

  const detectedType = SwarmOrchestrator.detectProjectType(idea.trim(), projectType);

  const newBuild = db.saveBuild({
    id: buildId,
    userId: user.id,
    idea: idea.trim(),
    projectType: detectedType,
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
    techStack: techStack || SwarmOrchestrator.selectOptimalTechStack(detectedType)
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

// Architecture Intelligence & Blueprint Endpoints
app.get('/api/tech-registry', requireAuth, (_req, res) => {
  res.json({ success: true, technologies: TechnologyStackRegistry.getAll() });
});

app.post('/api/architecture/analyze', requireAuth, (req, res) => {
  const { idea, projectType } = req.body;
  if (!idea || typeof idea !== 'string') {
    return res.status(400).json({ error: 'idea is required' });
  }
  const analysis = SoftwareRequirementsAnalyzer.analyze(idea.trim(), projectType);
  const stack = IntelligentStackSelector.selectStack(analysis);
  const complexity = ProjectComplexityEstimator.assess(analysis, stack);

  res.json({
    success: true,
    analysis,
    stack,
    complexity
  });
});

app.get('/api/builds/:id/architecture', requireAuth, (req, res) => {
  const build = db.getBuild(req.params.id);
  if (!build) return res.status(404).json({ error: 'Build not found' });
  if (build.userId !== req.user!.id) {
    return res.status(403).json({ error: 'Forbidden: You do not own this project.' });
  }

  const memory = ProjectMemoryService.getOrInitializeMemory(build.id, req.user!.id);
  const blueprint = memory?.architectureBlueprint || build.architectureBlueprint;
  const requirementsAnalysis = memory?.requirementsAnalysis || build.requirementsAnalysis;
  const complexityAssessment = memory?.complexityAssessment || build.complexityAssessment;
  const fileStructurePlan = memory?.fileStructurePlan || build.fileStructurePlan;
  const dependencyPlan = memory?.dependencyPlan || build.dependencyPlan;

  res.json({
    success: true,
    blueprint,
    requirementsAnalysis,
    complexityAssessment,
    fileStructurePlan,
    dependencyPlan,
    techStack: build.techStack,
    projectType: build.projectType
  });
});

app.post('/api/builds/:id/stop', requireAuth, (req, res) => {
  const build = db.getBuild(req.params.id);
  if (!build) return res.status(404).json({ error: 'Build not found' });
  if (build.userId !== req.user!.id) {
    return res.status(403).json({ error: 'Forbidden: You do not own this project.' });
  }

  SwarmOrchestrator.stopSwarm(req.params.id);
  for (const run of CodeGenerationEngine.getActiveRunsForBuild(req.params.id)) {
    CodeGenerationEngine.cancelRun(run.id, 'Build stopped by user');
  }
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

// Natural Language Project Revision endpoint (Scoped to project owner)
app.post('/api/builds/:id/revisions', requireAuth, async (req, res) => {
  const build = db.getBuild(req.params.id);
  if (!build) return res.status(404).json({ error: 'Build not found' });
  if (build.userId !== req.user!.id) {
    return res.status(403).json({ error: 'Forbidden: You do not own this project.' });
  }

  const { prompt } = req.body;
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'Revision prompt is required' });
  }

  const result = await SwarmOrchestrator.applyRevision(build.id, prompt.trim());
  if (!result.success) {
    return res.status(400).json({ error: result.error || 'Failed to queue revision' });
  }

  res.json({ 
    success: true, 
    revisionId: result.revisionId, 
    build: db.getBuild(build.id) 
  });
});

// Interactive Live Preview Document endpoint (Returns self-contained HTML for sandboxed iframe)
app.get('/api/builds/:id/preview', requireAuth, (req, res) => {
  const build = db.getBuild(req.params.id);
  if (!build) return res.status(404).json({ error: 'Build not found' });
  if (build.userId !== req.user!.id) {
    return res.status(403).json({ error: 'Forbidden: You do not own this project.' });
  }

  const files = db.getAllFiles(build.id);
  const preview = PreviewGenerator.generateInteractivePreview(
    build.idea, 
    files, 
    build.projectType || 'fullstack'
  );

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self' 'unsafe-inline' https: data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com https://unpkg.com https://fonts.googleapis.com https://esm.sh; style-src 'self' 'unsafe-inline' https:; font-src https://fonts.gstatic.com data:; object-src 'none'; base-uri 'self';; sandbox allow-scripts allow-forms allow-modals");
  res.send(preview.html);
});

// Structured Preview Bundle API endpoint
app.get('/api/builds/:id/preview-bundle', requireAuth, (req, res) => {
  const build = db.getBuild(req.params.id);
  if (!build) return res.status(404).json({ error: 'Build not found' });
  if (build.userId !== req.user!.id) {
    return res.status(403).json({ error: 'Forbidden: You do not own this project.' });
  }

  const files = db.getAllFiles(build.id);
  const preview = PreviewGenerator.generateInteractivePreview(
    build.idea, 
    files, 
    build.projectType || 'fullstack'
  );

  res.json({
    success: true,
    preview: {
      html: preview.html,
      title: preview.title,
      fileCount: preview.fileCount,
      generatedAt: preview.generatedAt,
      mode: preview.mode,
      entryPoint: preview.entryPoint,
      diagnosticInfo: preview.diagnosticInfo,
      runtimeErrors: preview.runtimeErrors,
      supportedDevices: preview.supportedDevices
    }
  });
});

// Project Intelligence & Persistent Memory Endpoint (Multi-tenant secured)
app.get('/api/builds/:id/memory', requireAuth, (req, res) => {
  const build = db.getBuild(req.params.id);
  if (!build) return res.status(404).json({ error: 'Build not found' });
  if (build.userId !== req.user!.id) {
    return res.status(403).json({ error: 'Forbidden: You do not own this project.' });
  }

  const memory = ProjectMemoryService.getOrInitializeMemory(build.id, req.user!.id);
  res.json({ success: true, memory });
});

app.get('/api/builds/:id/requirements', requireAuth, (req, res) => {
  const build = db.getBuild(req.params.id);
  if (!build) return res.status(404).json({ error: 'Build not found' });
  if (build.userId !== req.user!.id) {
    return res.status(403).json({ error: 'Forbidden: You do not own this project.' });
  }

  const requirements = ProjectMemoryService.getRequirements(build.id, req.user!.id);
  res.json({ success: true, requirements });
});

app.get('/api/builds/:id/defects', requireAuth, (req, res) => {
  const build = db.getBuild(req.params.id);
  if (!build) return res.status(404).json({ error: 'Build not found' });
  if (build.userId !== req.user!.id) {
    return res.status(403).json({ error: 'Forbidden: You do not own this project.' });
  }

  const defects = ProjectMemoryService.getDefects(build.id, req.user!.id);
  res.json({ success: true, defects });
});

app.get('/api/builds/:id/decisions', requireAuth, (req, res) => {
  const build = db.getBuild(req.params.id);
  if (!build) return res.status(404).json({ error: 'Build not found' });
  if (build.userId !== req.user!.id) {
    return res.status(403).json({ error: 'Forbidden: You do not own this project.' });
  }

  const decisions = ProjectMemoryService.getDecisions(build.id, req.user!.id);
  res.json({ success: true, decisions });
});

app.post('/api/builds/:id/decisions', requireAuth, (req, res) => {
  const build = db.getBuild(req.params.id);
  if (!build) return res.status(404).json({ error: 'Build not found' });
  if (build.userId !== req.user!.id) {
    return res.status(403).json({ error: 'Forbidden: You do not own this project.' });
  }

  const { id, title, context, decision, rationale, consequences } = req.body;
  if (!title || !decision) {
    return res.status(400).json({ error: 'title and decision are required' });
  }

  const adrId = id || `ADR-${Date.now().toString().slice(-4)}`;
  const recorded = ProjectMemoryService.recordDecision(build.id, req.user!.id, {
    id: adrId,
    title: String(title).trim(),
    context: String(context || '').trim(),
    decision: String(decision).trim(),
    rationale: rationale ? String(rationale).trim() : undefined,
    consequences: consequences ? String(consequences).trim() : undefined,
    status: 'accepted',
    timestamp: Date.now()
  });

  res.status(201).json({ success: recorded, decisions: ProjectMemoryService.getDecisions(build.id, req.user!.id) });
});

app.put('/api/builds/:id/requirements/:reqId', requireAuth, (req, res) => {
  const build = db.getBuild(req.params.id);
  if (!build) return res.status(404).json({ error: 'Build not found' });
  if (build.userId !== req.user!.id) {
    return res.status(403).json({ error: 'Forbidden: You do not own this project.' });
  }

  const { satisfied, status, notes, evidence, files } = req.body;
  if (typeof satisfied !== 'boolean' && typeof status !== 'string') {
    return res.status(400).json({ error: 'satisfied (boolean) or status (string) is required' });
  }

  const updated = ProjectMemoryService.updateRequirement(build.id, req.user!.id, req.params.reqId, {
    satisfied,
    status,
    notes,
    evidence,
    files
  });

  if (!updated) {
    return res.status(404).json({ error: `Requirement "${req.params.reqId}" not found in project` });
  }

  res.json({ success: true, requirements: ProjectMemoryService.getRequirements(build.id, req.user!.id) });
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
    const { valid, cleanPath } = ExecutionAdapter.sanitizeFilePath(f.path);
    if (valid && cleanPath) {
      zip.file(cleanPath, f.content);
    }
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

// =========================================================================
// PHASE 8: COLLABORATIVE AI DEVELOPMENT SYSTEM API ENDPOINTS
// =========================================================================

// Helper for multi-tenant build verification
function verifyBuildOwnership(req: express.Request, res: express.Response, buildId: string) {
  const build = db.getBuild(buildId);
  if (!build) {
    res.status(404).json({ error: 'Build not found' });
    return null;
  }
  if (build.userId !== req.user!.id) {
    res.status(403).json({ error: 'Forbidden: Unauthorized access to build' });
    return null;
  }
  return build;
}

// 1. Collaboration Overview & Agent Profiles
app.get('/api/builds/:id/collaboration/overview', requireAuth, (req, res) => {
  const build = verifyBuildOwnership(req, res, req.params.id);
  if (!build) return;

  const agents = db.getAgentProfiles(build.id);
  const { total: messageCount } = db.getAgentMessages(build.id, { limit: 1 });
  const { reviews } = db.getCodeReviews(build.id);
  const pendingReviewsCount = reviews.filter(r => r.status === 'pending' || r.status === 'under_review').length;
  const patches = db.getPatchProposals(build.id);
  const proposedPatchesCount = patches.filter(p => p.applicationStatus === 'proposed').length;
  const challenges = db.getAIChallenges(build.id);
  const activeChallengesCount = challenges.filter(c => c.status === 'active').length;
  const defects = db.getDefects(build.id);
  const openDefectsCount = defects.filter(d => d.status !== 'resolved').length;
  const conflicts = db.getFileConflicts(build.id);
  const activeConflictsCount = conflicts.filter(c => c.resolutionStatus !== 'resolved').length;
  const approvals = db.getApprovalRequests(build.id);
  const pendingApprovalsCount = approvals.filter(a => a.status === 'pending').length;
  const knowledge = db.getKnowledgeItems(build.id);

  res.json({
    activeAgents: agents.length > 0 ? agents : CollaborationManager.initializeBuildAgents(build.id, build.selectedModels),
    messageCount,
    pendingReviewsCount,
    proposedPatchesCount,
    activeChallengesCount,
    openDefectsCount,
    activeConflictsCount,
    pendingApprovalsCount,
    knowledgeItemsCount: knowledge.length
  });
});

app.get('/api/builds/:id/collaboration/agents', requireAuth, (req, res) => {
  const build = verifyBuildOwnership(req, res, req.params.id);
  if (!build) return;

  let agents = db.getAgentProfiles(build.id);
  if (agents.length === 0) {
    agents = CollaborationManager.initializeBuildAgents(build.id, build.selectedModels);
  }
  res.json({ agents });
});

// 2. Intelligent Agent Messages
app.get('/api/builds/:id/collaboration/messages', requireAuth, (req, res) => {
  const build = verifyBuildOwnership(req, res, req.params.id);
  if (!build) return;

  const { messageType, sender, taskId, search, limit, offset } = req.query;
  const result = CollaborationManager.getMessages(build.id, req.user!.id, {
    messageType: messageType as any,
    sender: sender as string,
    taskId: taskId as string,
    search: search as string,
    limit: limit ? parseInt(limit as string, 10) : 50,
    offset: offset ? parseInt(offset as string, 10) : 0
  });

  res.json(result);
});

app.post('/api/builds/:id/collaboration/messages', requireAuth, (req, res) => {
  const build = verifyBuildOwnership(req, res, req.params.id);
  if (!build) return;

  const {
    sender,
    senderRole,
    recipient,
    messageType,
    content,
    relatedTaskId,
    relatedFiles,
    parentMessageId
  } = req.body;

  if (!senderRole || !messageType || !content) {
    return res.status(400).json({ error: 'senderRole, messageType, and content are required' });
  }

  const result = CollaborationManager.sendMessage(build.id, req.user!.id, {
    sender: sender || `${senderRole}_agent`,
    senderRole,
    recipient,
    messageType,
    content,
    relatedTaskId,
    relatedFiles,
    parentMessageId
  });

  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }
  res.json(result);
});

// 3. Shared Workspace Version-Aware Context
app.get('/api/builds/:id/collaboration/workspace-context', requireAuth, (req, res) => {
  const build = verifyBuildOwnership(req, res, req.params.id);
  if (!build) return;

  const taskId = req.query.taskId as string;
  const agentRole = (req.query.agentRole as string) || 'fullstack_developer';
  if (!taskId) {
    return res.status(400).json({ error: 'taskId query parameter is required' });
  }

  const result = SharedWorkspaceService.getAgentWorkspaceContext(
    build.id,
    req.user!.id,
    taskId,
    agentRole as any
  );

  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }
  res.json(result);
});

// 4. Code Review Engine
app.get('/api/builds/:id/collaboration/reviews', requireAuth, (req, res) => {
  const build = verifyBuildOwnership(req, res, req.params.id);
  if (!build) return;

  const { taskId, status, limit, offset } = req.query;
  const result = db.getCodeReviews(build.id, {
    taskId: taskId as string,
    status: status as string,
    limit: limit ? parseInt(limit as string, 10) : 50,
    offset: offset ? parseInt(offset as string, 10) : 0
  });

  res.json(result);
});

app.get('/api/builds/:id/collaboration/reviews/:reviewId', requireAuth, (req, res) => {
  const build = verifyBuildOwnership(req, res, req.params.id);
  if (!build) return;

  const review = db.getCodeReview(req.params.reviewId);
  if (!review || review.buildId !== build.id) {
    return res.status(404).json({ error: 'Code review not found' });
  }

  res.json({ review });
});

app.post('/api/builds/:id/collaboration/reviews', requireAuth, (req, res) => {
  const build = verifyBuildOwnership(req, res, req.params.id);
  if (!build) return;

  const result = CodeReviewEngine.submitForReview(build.id, req.user!.id, req.body);
  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }
  res.json(result);
});

app.post('/api/builds/:id/collaboration/reviews/:reviewId/verdict', requireAuth, (req, res) => {
  const build = verifyBuildOwnership(req, res, req.params.id);
  if (!build) return;

  const { reviewerAgent, verdict, checks, summaryComments } = req.body;
  if (!verdict) {
    return res.status(400).json({ error: 'verdict is required' });
  }

  const result = CodeReviewEngine.submitVerdict(build.id, req.user!.id, {
    reviewId: req.params.reviewId,
    reviewerAgent: reviewerAgent || 'qa_testing_specialist',
    verdict,
    checks,
    summaryComments
  });

  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }
  res.json(result);
});

app.post('/api/builds/:id/collaboration/reviews/:reviewId/comments', requireAuth, (req, res) => {
  const build = verifyBuildOwnership(req, res, req.params.id);
  if (!build) return;

  const result = CodeReviewEngine.addComment(build.id, req.user!.id, {
    ...req.body,
    reviewId: req.params.reviewId
  });

  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }
  res.json(result);
});

// 5. Patch Proposal & Safe Integration Pipeline
app.get('/api/builds/:id/collaboration/patches', requireAuth, (req, res) => {
  const build = verifyBuildOwnership(req, res, req.params.id);
  if (!build) return;

  const { targetFile, status } = req.query;
  const patches = db.getPatchProposals(build.id, {
    targetFile: targetFile as string,
    status: status as string
  });

  res.json({ patches });
});

app.post('/api/builds/:id/collaboration/patches', requireAuth, (req, res) => {
  const build = verifyBuildOwnership(req, res, req.params.id);
  if (!build) return;

  const result = PatchValidationPipeline.proposePatch(build.id, req.user!.id, req.body);
  if (!result.success && !result.conflict) {
    return res.status(400).json({ error: result.error });
  }
  res.json(result);
});

app.post('/api/builds/:id/collaboration/patches/:patchId/apply', requireAuth, async (req, res) => {
  const build = verifyBuildOwnership(req, res, req.params.id);
  if (!build) return;

  const result = await PatchValidationPipeline.applyApprovedPatch(build.id, req.user!.id, req.params.patchId);
  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }
  res.json(result);
});

// 6. File Conflicts & Resolution
app.get('/api/builds/:id/collaboration/conflicts', requireAuth, (req, res) => {
  const build = verifyBuildOwnership(req, res, req.params.id);
  if (!build) return;

  const status = req.query.status as string;
  const conflicts = db.getFileConflicts(build.id, status);
  res.json({ conflicts });
});

app.post('/api/builds/:id/collaboration/conflicts/:conflictId/resolve', requireAuth, async (req, res) => {
  const build = verifyBuildOwnership(req, res, req.params.id);
  if (!build) return;

  const { resolvedBy, resolvedContent, resolutionExplanation } = req.body;
  if (!resolvedContent) {
    return res.status(400).json({ error: 'resolvedContent is required' });
  }

  const result = await PatchValidationPipeline.resolveConflict(build.id, req.user!.id, {
    conflictId: req.params.conflictId,
    resolvedBy: resolvedBy || 'integration_specialist',
    resolvedContent,
    resolutionExplanation: resolutionExplanation || 'Manual conflict resolution'
  });

  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }
  res.json(result);
});

// 7. AI Challenge Mode
app.get('/api/builds/:id/collaboration/challenges', requireAuth, (req, res) => {
  const build = verifyBuildOwnership(req, res, req.params.id);
  if (!build) return;

  const challenges = db.getAIChallenges(build.id);
  res.json({ challenges });
});

app.post('/api/builds/:id/collaboration/challenges', requireAuth, (req, res) => {
  const build = verifyBuildOwnership(req, res, req.params.id);
  if (!build) return;

  const { subject, originalProposal, proposerAgent, proposerRole, challengerRole, taskId } = req.body;
  if (!subject || !originalProposal) {
    return res.status(400).json({ error: 'subject and originalProposal are required' });
  }

  const result = AIChallengeEngine.startChallenge(build.id, req.user!.id, {
    subject,
    originalProposal,
    proposerAgent: proposerAgent || `${proposerRole || 'software_architect'}_agent`,
    proposerRole: proposerRole || 'software_architect',
    challengerRole,
    taskId
  });

  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }
  res.json(result);
});

app.post('/api/builds/:id/collaboration/challenges/:challengeId/arguments', requireAuth, (req, res) => {
  const build = verifyBuildOwnership(req, res, req.params.id);
  if (!build) return;

  const result = AIChallengeEngine.addArgument(build.id, req.user!.id, {
    ...req.body,
    challengeId: req.params.challengeId
  });

  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }
  res.json(result);
});

app.post('/api/builds/:id/collaboration/challenges/:challengeId/conclude', requireAuth, (req, res) => {
  const build = verifyBuildOwnership(req, res, req.params.id);
  if (!build) return;

  const { outcome, finalDecision, decisionRationale, decisionMaker, decisionMakerRole } = req.body;
  if (!outcome || !finalDecision) {
    return res.status(400).json({ error: 'outcome and finalDecision are required' });
  }

  const result = AIChallengeEngine.concludeChallenge(build.id, req.user!.id, {
    challengeId: req.params.challengeId,
    decisionMaker: decisionMaker || 'software_architect',
    decisionMakerRole: decisionMakerRole || 'software_architect',
    outcome,
    finalDecision,
    decisionRationale: decisionRationale || 'Evaluated technical trade-offs and evidence'
  });

  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }
  res.json(result);
});

// 8. Collaborative Debugging Engine
app.get('/api/builds/:id/collaboration/defects', requireAuth, (req, res) => {
  const build = verifyBuildOwnership(req, res, req.params.id);
  if (!build) return;

  const { status, severity } = req.query;
  const defects = db.getDefects(build.id, {
    status: status as string,
    severity: severity as string
  });

  res.json({ defects });
});

app.post('/api/builds/:id/collaboration/defects', requireAuth, (req, res) => {
  const build = verifyBuildOwnership(req, res, req.params.id);
  if (!build) return;

  const result = CollaborativeDebuggingEngine.recordDefect(build.id, req.user!.id, req.body);
  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }
  res.json(result);
});

app.post('/api/builds/:id/collaboration/defects/:defectId/solutions', requireAuth, (req, res) => {
  const build = verifyBuildOwnership(req, res, req.params.id);
  if (!build) return;

  const result = CollaborativeDebuggingEngine.proposeSolution(build.id, req.user!.id, {
    ...req.body,
    defectId: req.params.defectId
  });

  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }
  res.json(result);
});

app.post('/api/builds/:id/collaboration/defects/:defectId/status', requireAuth, (req, res) => {
  const build = verifyBuildOwnership(req, res, req.params.id);
  if (!build) return;

  const { status, verificationEvidence, testEvidence } = req.body;
  if (!status) {
    return res.status(400).json({ error: 'status is required' });
  }

  const result = CollaborativeDebuggingEngine.updateStatus(build.id, req.user!.id, {
    defectId: req.params.defectId,
    status,
    verificationEvidence,
    testEvidence
  });

  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }
  res.json(result);
});

// 9. Human Approval Workflows
app.get('/api/builds/:id/collaboration/approvals', requireAuth, (req, res) => {
  const build = verifyBuildOwnership(req, res, req.params.id);
  if (!build) return;

  const status = req.query.status as string;
  const approvals = db.getApprovalRequests(build.id, status);
  res.json({ approvals });
});

app.post('/api/builds/:id/collaboration/approvals', requireAuth, (req, res) => {
  const build = verifyBuildOwnership(req, res, req.params.id);
  if (!build) return;

  // A client can ask for review, but cannot supply what approval would apply or authorize
  const { patchId, taskId, proposedActions, contentHashes, scopeHash, ...requestFields } = req.body;
  const result = ApprovalGateService.requestApproval(build.id, req.user!.id, requestFields);
  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }
  res.json(result);
});

app.post('/api/builds/:id/collaboration/approvals/:approvalId/respond', requireAuth, (req, res) => {
  const build = verifyBuildOwnership(req, res, req.params.id);
  if (!build) return;

  const { approved, resolutionNotes, notes } = req.body;
  if (typeof approved !== 'boolean') {
    return res.status(400).json({ error: 'approved (boolean) is required' });
  }

  const result = ApprovalGateService.respondToApproval(build.id, req.user!.id, {
    requestId: req.params.approvalId,
    approved,
    resolutionNotes: resolutionNotes ?? notes
  });

  // A run waiting on a request that can no longer be approved must not wait forever
  const decided = db.getApprovalRequest(req.params.approvalId);
  if (decided?.buildId === build.id && decided.status === 'expired') {
    if (decided.patchId) CodeGenerationEngine.cancelRun(decided.patchId, 'Approval expired');
    else SwarmOrchestrator.resolveHeldTask(decided).catch(err => console.error('Held task failed:', err.message));
  }
  if (decided?.buildId === build.id && decided.patchId && decided.status === 'rejected') {
    CodeGenerationEngine.cancelRun(decided.patchId, 'Approval rejected');
  }
  if (decided?.buildId === build.id) {
    repairCoordinator.handleApprovalDecision(decided, req.user!)
      .catch(err => console.error('Repair could not continue:', err.message));
  }

  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }

  // Apply the reviewed changes in the background, because a run can take a while
  if (result.request?.taskId && !result.request.patchId) {
    SwarmOrchestrator.resolveHeldTask(result.request)
      .catch(err => console.error('Held task failed:', err.message));
  } else if (approved && result.request) {
    CodeGenerationEngine.continueApprovedRun(result.request, req.user!.id)
      .catch(err => console.error('Approved run failed:', err.message));
  }
  res.json(result);
});

app.post('/api/builds/:id/collaboration/approvals/:approvalId/revoke', requireAuth, (req, res) => {
  const build = verifyBuildOwnership(req, res, req.params.id);
  if (!build) return;

  const result = ApprovalGateService.revokeApproval(build.id, req.user!.id, req.params.approvalId);
  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }
  if (result.request?.patchId) {
    const run = db.getGenerationRun(result.request.patchId);
    if (run?.buildId === build.id && run.status === 'pending_approval') {
      CodeGenerationEngine.cancelRun(run.id, 'Approval revoked');
    }
  }
  res.json(result);
});

// 10. Shared Technical Knowledge
app.get('/api/builds/:id/collaboration/knowledge', requireAuth, (req, res) => {
  const build = verifyBuildOwnership(req, res, req.params.id);
  if (!build) return;

  const { category, search, status } = req.query;
  const items = ProjectMemoryService.searchKnowledge(build.id, req.user!.id, {
    category: category as string,
    search: search as string,
    status: status as string
  });

  res.json({ items });
});

app.post('/api/builds/:id/collaboration/knowledge', requireAuth, (req, res) => {
  const build = verifyBuildOwnership(req, res, req.params.id);
  if (!build) return;

  const result = ProjectMemoryService.recordKnowledgeItem(build.id, req.user!.id, req.body);
  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }
  res.json(result);
});

app.post('/api/builds/:id/collaboration/knowledge/:knowledgeId/supersede', requireAuth, (req, res) => {
  const build = verifyBuildOwnership(req, res, req.params.id);
  if (!build) return;

  const { newContent, newTitle, supersedeReason, sourceAgent, sourceRole } = req.body;
  if (!newContent || !supersedeReason) {
    return res.status(400).json({ error: 'newContent and supersedeReason are required' });
  }

  const result = ProjectMemoryService.supersedeKnowledgeItem(build.id, req.user!.id, {
    targetId: req.params.knowledgeId,
    sourceAgent: sourceAgent || 'software_architect',
    sourceRole: sourceRole || 'software_architect',
    newContent,
    newTitle,
    supersedeReason
  });

  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }
  res.json(result);
});

// 11. Advanced Task Delegation
app.post('/api/builds/:id/collaboration/tasks/:taskId/delegate', requireAuth, (req, res) => {
  const build = verifyBuildOwnership(req, res, req.params.id);
  if (!build) return;

  const { delegatorRole, targetRole, rationale } = req.body;
  if (!targetRole) {
    return res.status(400).json({ error: 'targetRole is required' });
  }

  const result = TaskManager.delegateTask(
    build.id,
    req.params.taskId,
    delegatorRole || 'project_manager',
    targetRole,
    rationale || 'Specialized expertise alignment'
  );

  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }
  res.json(result);
});

app.post('/api/builds/:id/collaboration/tasks/:taskId/accept', requireAuth, (req, res) => {
  const build = verifyBuildOwnership(req, res, req.params.id);
  if (!build) return;

  const { agentRole } = req.body;
  const result = TaskManager.acceptTask(build.id, req.params.taskId, agentRole || 'fullstack_developer');
  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }
  res.json(result);
});

app.post('/api/builds/:id/collaboration/tasks/:taskId/reject', requireAuth, (req, res) => {
  const build = verifyBuildOwnership(req, res, req.params.id);
  if (!build) return;

  const { agentRole, reason } = req.body;
  const result = TaskManager.rejectTask(
    build.id,
    req.params.taskId,
    agentRole || 'fullstack_developer',
    reason || 'Role capability mismatch'
  );

  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }
  res.json(result);
});

app.post('/api/builds/:id/collaboration/tasks/:taskId/escalate', requireAuth, (req, res) => {
  const build = verifyBuildOwnership(req, res, req.params.id);
  if (!build) return;

  const { senderRole, reason } = req.body;
  const result = TaskManager.escalateTask(
    build.id,
    req.params.taskId,
    senderRole || 'qa_testing_specialist',
    reason || 'Requires architectural intervention'
  );

  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }
  res.json(result);
});

// ==========================================
// PHASE 9: INTELLIGENT CODE GENERATION ENDPOINTS
// ==========================================

// Get all specialized generation profiles and platform constraints
app.get('/api/codegen/profiles', (_req, res) => {
  const profiles = GenerationProfileRegistry.getAll();
  res.json({ profiles });
});

// Run the 6-Pass Intelligent Code Generation Pipeline
app.post('/api/builds/:id/codegen/run', requireAuth, async (req, res) => {
  const build = verifyBuildOwnership(req, res, req.params.id);
  if (!build) return;

  const { userRequest, profileId, modelId, taskId, maxRepairAttempts } = req.body;
  if (!userRequest || typeof userRequest !== 'string' || !userRequest.trim()) {
    return res.status(400).json({ error: 'userRequest must be a non-empty string' });
  }

  try {
    const runRecord = await CodeGenerationEngine.runGenerationPipeline({
      buildId: build.id,
      userId: req.user!.id,
      userRequest: userRequest.trim(),
      profileId,
      modelId,
      taskId,
      maxRepairAttempts: typeof maxRepairAttempts === 'number' ? maxRepairAttempts : 3
    });

    res.json({ success: true, run: runRecord });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Generation pipeline failed' });
  }
});

// Get generation runs history for a build
app.get('/api/builds/:id/codegen/runs', requireAuth, (req, res) => {
  const build = verifyBuildOwnership(req, res, req.params.id);
  if (!build) return;

  const runs = db.getGenerationRunsByBuild(build.id);
  res.json({ runs });
});

// Get a single generation run detail
app.get('/api/builds/:id/codegen/runs/:runId', requireAuth, (req, res) => {
  const build = verifyBuildOwnership(req, res, req.params.id);
  if (!build) return;

  const run = db.getGenerationRun(req.params.runId);
  if (!run || run.buildId !== build.id) {
    return res.status(404).json({ error: 'Generation run not found' });
  }
  res.json({ run });
});

// Cancel a generation run
app.post('/api/builds/:id/codegen/runs/:runId/cancel', requireAuth, (req, res) => {
  const build = verifyBuildOwnership(req, res, req.params.id);
  if (!build) return;

  const run = db.getGenerationRun(req.params.runId);
  if (!run || run.buildId !== build.id) {
    return res.status(404).json({ error: 'Generation run not found' });
  }

  const { reason } = req.body;
  const cancellationReason = typeof reason === 'string' && reason.trim() ? reason.trim() : 'Run was cancelled by user';
  const cancelled = CodeGenerationEngine.cancelRun(run.id, cancellationReason);

  const updatedRun = db.getGenerationRun(run.id) || run;
  res.json({ success: cancelled, run: updatedRun });
});

// Preview discovered project context & established contracts for a requirement
app.post('/api/builds/:id/codegen/preview-context', requireAuth, (req, res) => {
  const build = verifyBuildOwnership(req, res, req.params.id);
  if (!build) return;

  const { userRequest, targetFiles } = req.body;
  const files = db.getAllFiles(build.id);
  const context = ProjectContextEngine.buildProjectContext(
    userRequest || build.idea,
    files,
    Array.isArray(targetFiles) ? targetFiles : [],
    3500
  );

  const profile = GenerationProfileRegistry.matchProfileForRequest(userRequest || build.idea, build.projectType);
  const synthesizedContracts = ContractFirstEngine.synthesizeInitialContracts(
    userRequest || build.idea,
    profile.id,
    Array.isArray(targetFiles) ? targetFiles : []
  );

  res.json({
    profile,
    context,
    synthesizedContracts
  });
});

// Project execution runs only through the sandbox backend
app.use('/api/builds/:id/execution', createExecutionRouter({
  requireAuth,
  verifyBuildOwnership,
  manager: executionManager,
  previews: previewService
}));

// Debugging and repair of a project's own errors
app.use('/api/builds/:id/debugging', createDebuggingRouter({
  requireAuth,
  verifyBuildOwnership,
  coordinator: repairCoordinator
}));

// Mount Vite in dev mode or serve static bundle in production
async function startServer() {
  const server = http.createServer(app);
  const stopExecutionServices = await startExecutionServices();

  const isProd = process.env.NODE_ENV === 'production';
  const distPath = path.resolve(process.cwd(), 'dist');

  if (isProd && fs.existsSync(distPath)) {
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { 
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR === 'true' ? false : { server }
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use by another process.`);
    } else {
      console.error('Server error encountered:', err);
    }
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`SquadForge Autonomous Team Server running on http://0.0.0.0:${PORT}`);
  });

  const shutdown = (signal: string) => {
    console.log(`Received ${signal}. Shutting down gracefully...`);
    stopExecutionServices();
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

const isTestRun = process.env.NODE_ENV === 'test' || process.argv.some(arg => arg.includes('test'));
if (!isTestRun) {
  startServer().catch((err) => {
    console.error('Fatal error starting server:', err);
    process.exit(1);
  });
}

export { app, resolveUser };
