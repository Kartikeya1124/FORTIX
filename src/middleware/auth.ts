import { Request, Response, NextFunction } from 'express';
import { extractRequestToken, verifyAndResolveJwtUser, getJwtSecret } from '../lib/jwt-security.js';

// Validate secret availability at module load in production
getJwtSecret();

export interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: string;
    emailVerified?: boolean;
  };
}

export const authenticate = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const token = extractRequestToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const verifiedUser = await verifyAndResolveJwtUser(token);
    if (!verifiedUser) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    req.user = verifiedUser;
    next();
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }
};

export const requireAdmin = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (req.user.role !== 'ADMIN') {
    return res.status(403).json({
      error: 'Forbidden: Administrative privileges required',
      code: 'ADMIN_ROLE_REQUIRED',
    });
  }
  next();
};
