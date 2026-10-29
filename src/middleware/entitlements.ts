import { Response, NextFunction } from 'express';
import { AuthRequest } from './auth.js';

export type FeatureEntitlement =
  | 'ADVANCED_EXPERIMENTS'
  | 'POLICY_VERIFICATION'
  | 'ADVANCED_ANALYTICS'
  | 'TOPOLOGY'
  | 'EXPORT_REPORTS'
  | 'REALTIME_TELEMETRY'
  | 'ADVANCED_SECURITY'
  | 'EXPERIMENT_SCHEDULING'
  | 'API_KEY_MANAGEMENT'
  | 'ADVANCED_RATE_LIMITING';

export const requireEntitlement = (entitlement: FeatureEntitlement) => {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // ADMIN and DEVELOPER operators have workspace entitlements strictly within their own owned projects
    // (project ownership is independently enforced by requireProjectOwnership / route queries).
    // Read-only VIEWER accounts are restricted from operational entitlements.
    if (req.user.role === 'ADMIN' || req.user.role === 'DEVELOPER') {
      return next();
    }

    return res.status(403).json({
      error: 'Entitlement required',
      message: `Your role (${req.user.role}) does not include access to ${entitlement}.`,
    });
  };
};
