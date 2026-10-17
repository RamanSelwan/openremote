import { verifyToken } from '../utils/tokens.js';
import User from '../models/User.js';

/** Requires a valid `Authorization: Bearer <jwt>` header. */
export async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'missing token' });

    const payload = verifyToken(token);
    const user = await User.findById(payload.sub);
    if (!user) return res.status(401).json({ error: 'unknown user' });

    req.user = user;
    return next();
  } catch {
    return res.status(401).json({ error: 'invalid or expired token' });
  }
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'admin only' });
  }
  return next();
}
