import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import * as dotenv from 'dotenv';

dotenv.config({ override: true });

const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'fortix_local_dev_secret_key_32_characters_minimum_entropy');
if (!JWT_SECRET) throw new Error("JWT_SECRET must be set");

export interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: string;
  };
}

export const authenticate = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    // Use a custom header to avoid collision with AI Studio's injected Authorization header
    const headerToken = req.headers['x-fortix-token'];
    let token: string | undefined = Array.isArray(headerToken) ? headerToken[0] : headerToken;
    if (!token && req.headers.authorization?.startsWith('Bearer ')) {
      // For integration tests
      token = req.headers.authorization.split(' ')[1];
    }
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    
    // Validate token
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as unknown as { id: string; email: string };
    
    // Verify user still exists
    const [user] = await db.select().from(users).where(eq(users.id, decoded.id)).limit(1);
    
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    req.user = { id: user.id, email: user.email, role: user.role };
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
};
