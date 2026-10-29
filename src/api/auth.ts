import { v4 as uuidv4 } from 'uuid';
import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import rateLimit from 'express-rate-limit';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import {
  getJwtSecret,
  computePasswordVersion,
  extractRequestToken,
  revokeJwtToken,
  recordPasswordRotation,
  verifyAndResolveJwtUser,
} from '../lib/jwt-security.js';
import {
  issueSessionCookie,
  issueCsrfCookie,
  clearSessionCookies,
} from '../lib/cors-csrf.js';
import {
  issueAuthActionToken,
  consumeAuthActionToken,
} from '../lib/auth-tokens.js';
import { disconnectSocketsForToken, disconnectSocketsForUser } from '../socket.js';

getJwtSecret();

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () =>
    (process.env.NODE_ENV === 'test' || process.env.VITEST === 'true') &&
    process.env.ENFORCE_AUTH_RATE_LIMIT !== 'true',
  validate: {
    xForwardedForHeader: false,
    forwardedHeader: false,
    trustProxy: false,
  },
  message: { error: 'Too many authentication attempts. Please try again after 1 minute.' },
});

router.use(authLimiter);

// Strictly omit role from client registration payload; new registrants ALWAYS receive DEVELOPER
const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8).max(128),
  name: z.string().trim().max(120).optional(),
});

router.post('/register', async (req, res) => {
  try {
    const { email, password } = registerSchema.parse(req.body);

    const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (existing) {
      return res.status(409).json({ error: 'User already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const [user] = await db
      .insert(users)
      .values({
        id: uuidv4(),
        email,
        passwordHash,
        role: 'DEVELOPER',
        emailVerified: false,
      })
      .returning();

    let verificationPreviewToken: string | undefined;
    try {
      const issued = await issueAuthActionToken(user.id, user.email, 'EMAIL_VERIFICATION');
      if (process.env.NODE_ENV !== 'production' && process.env.EXPOSE_DEV_AUTH_TOKENS !== 'false') {
        verificationPreviewToken = issued.rawToken;
      }
    } catch (tokenErr) {
      console.warn('[Auth] Failed to issue initial email verification token:', tokenErr);
    }

    res.status(201).json({
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        emailVerified: Boolean(user.emailVerified),
      },
      ...(verificationPreviewToken ? { devVerificationToken: verificationPreviewToken } : {}),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.issues });
    }
    console.error('Register error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(128),
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = loginSchema.parse(req.body);

    // Block demo credentials in production unless explicitly enabled
    const isDemoAccount = email === 'admin@fortix.test' || email === 'admin@fortix.io';
    if (process.env.NODE_ENV === 'production' && isDemoAccount && process.env.ALLOW_DEMO_ACCOUNTS !== 'true') {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role,
        pwdVer: computePasswordVersion(user.passwordHash),
        jti: uuidv4(),
      },
      getJwtSecret(),
      {
        expiresIn: '1d',
        algorithm: 'HS256',
      }
    );

    issueSessionCookie(req, res, token);
    const csrfToken = issueCsrfCookie(req, res);

    res.json({
      token,
      csrfToken,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        emailVerified: Boolean(user.emailVerified),
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.issues });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/logout', async (req, res) => {
  const token = extractRequestToken(req);
  if (token) {
    await revokeJwtToken(token);
    disconnectSocketsForToken(token);
  }
  clearSessionCookies(req, res);
  res.json({ message: 'Logged out successfully' });
});

router.get('/me', async (req, res) => {
  try {
    const token = extractRequestToken(req);
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    const user = await verifyAndResolveJwtUser(token);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const csrfToken = issueCsrfCookie(req, res);
    res.json({ user, csrfToken });
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
});

const forgotPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
});

router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = forgotPasswordSchema.parse(req.body);
    const genericMessage =
      'If an account matches that email address, a single-use password reset token has been dispatched.';

    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    let devResetToken: string | undefined;

    if (user) {
      const issued = await issueAuthActionToken(user.id, user.email, 'PASSWORD_RESET');
      if (process.env.NODE_ENV !== 'production' && process.env.EXPOSE_DEV_AUTH_TOKENS !== 'false') {
        devResetToken = issued.rawToken;
      }
    }

    res.status(200).json({
      message: genericMessage,
      ...(devResetToken ? { devResetToken } : {}),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid email address', details: error.issues });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

const resetPasswordSchema = z.object({
  token: z.string().trim().min(32).max(256),
  newPassword: z.string().min(8).max(128),
});

router.post('/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = resetPasswordSchema.parse(req.body);
    const consumed = await consumeAuthActionToken(token, 'PASSWORD_RESET');
    if (!consumed.valid || !consumed.userId) {
      return res.status(400).json({ error: consumed.reason || 'Invalid or expired token', code: 'INVALID_RESET_TOKEN' });
    }

    const [user] = await db.select().from(users).where(eq(users.id, consumed.userId)).limit(1);
    if (!user) {
      return res.status(400).json({ error: 'Invalid or expired token', code: 'INVALID_RESET_TOKEN' });
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    await db.update(users).set({ passwordHash: newHash }).where(eq(users.id, user.id));
    await recordPasswordRotation(user.id, newHash);
    disconnectSocketsForUser(user.id);
    clearSessionCookies(req, res);

    res.status(200).json({ message: 'Password has been reset successfully. Please sign in with your new password.' });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid password reset request', details: error.issues });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

const verifyEmailSchema = z.object({
  token: z.string().trim().min(32).max(256),
});

router.post('/verify-email', async (req, res) => {
  try {
    const { token } = verifyEmailSchema.parse(req.body);
    const consumed = await consumeAuthActionToken(token, 'EMAIL_VERIFICATION');
    if (!consumed.valid || !consumed.userId) {
      return res.status(400).json({ error: consumed.reason || 'Invalid or expired token', code: 'INVALID_VERIFICATION_TOKEN' });
    }

    await db.update(users).set({ emailVerified: true }).where(eq(users.id, consumed.userId));
    res.status(200).json({ verified: true, message: 'Email address verified successfully.' });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid verification token', details: error.issues });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/resend-verification', async (req, res) => {
  try {
    const sessionToken = extractRequestToken(req);
    if (!sessionToken) return res.status(401).json({ error: 'Unauthorized' });

    const sessionUser = await verifyAndResolveJwtUser(sessionToken);
    if (!sessionUser) return res.status(401).json({ error: 'Unauthorized' });

    if (sessionUser.emailVerified) {
      return res.status(200).json({ message: 'Email is already verified.' });
    }

    const issued = await issueAuthActionToken(sessionUser.id, sessionUser.email, 'EMAIL_VERIFICATION');
    res.status(200).json({
      message: 'Verification token dispatched.',
      ...(process.env.NODE_ENV !== 'production' && process.env.EXPOSE_DEV_AUTH_TOKENS !== 'false'
        ? { devVerificationToken: issued.rawToken }
        : {}),
    });
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

export const authRouter = router;
