import { v4 as uuidv4 } from 'uuid';
import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import * as dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';

dotenv.config({ override: true });
const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'fortix_local_dev_secret_key_32_characters_minimum_entropy');
if (!JWT_SECRET) throw new Error("JWT_SECRET must be set");

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  validate: {
    xForwardedForHeader: false,
    forwardedHeader: false,
    trustProxy: false
  },
  message: { error: 'Too many authentication attempts. Please try again after 1 minute.' }
});

router.use(authLimiter);

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().optional()
});

router.post('/register', async (req, res) => {
  try {
    const { email, password, name } = registerSchema.parse(req.body);
    
    const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (existing) {
      return res.status(409).json({ error: 'User already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    
    const [user] = await db.insert(users).values({
      id: uuidv4(),
      email,
      passwordHash,
      role: 'ADMIN'
    }).returning();

    res.status(201).json({ user: { id: user.id, email: user.email, role: user.role } });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.issues });
    }
    console.error('Register error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});


const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = loginSchema.parse(req.body);

    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, {
      expiresIn: '1d',
      algorithm: 'HS256',
    });

    res.json({ token, user: { id: user.id, email: user.email, role: user.role } });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.issues });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie('fortix_token');
  res.json({ message: 'Logged out successfully' });
});

router.get('/me', async (req, res) => {
  try {
    let token = req.headers['x-fortix-token'] as string;
    if (!token && req.headers.authorization?.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    }
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as { id: string; email: string; role: string };
    const [user] = await db.select().from(users).where(eq(users.id, decoded.id)).limit(1);
    
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    res.json({ user: { id: user.id, email: user.email, role: user.role } });
  } catch (error) {
    res.status(401).json({ error: 'Unauthorized' });
  }
});

export const authRouter = router;
