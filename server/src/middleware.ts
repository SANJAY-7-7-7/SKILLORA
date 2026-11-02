import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { User } from './models.js';

declare global { namespace Express { interface Request { userId?: string; role?: string } } }

export async function authenticate(req: Request, res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.skillora_session || req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ message: 'Please sign in to continue.' });
    const payload = jwt.verify(token, config.jwtSecret) as { sub: string };
    const user = await User.findById(payload.sub).select('role suspendedAt');
    if (!user || user.suspendedAt) return res.status(401).json({ message: 'This account is unavailable.' });
    req.userId = String(user._id); req.role = user.role;
    next();
  } catch { return res.status(401).json({ message: 'Your session has expired. Please sign in again.' }); }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.role !== 'admin') return res.status(403).json({ message: 'Administrator access is required.' });
  next();
}

export function asyncRoute(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => { void fn(req, res, next).catch(next); };
}
