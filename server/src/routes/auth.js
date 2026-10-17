import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import User from '../models/User.js';
import { signToken } from '../utils/tokens.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too many attempts, try again later' },
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** POST /api/auth/register */
router.post('/register', authLimiter, async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (!email || !EMAIL_RE.test(String(email))) {
    return res.status(400).json({ error: 'valid email is required' });
  }
  if (!password || String(password).length < 8) {
    return res.status(400).json({ error: 'password must be at least 8 characters' });
  }

  const normalized = String(email).toLowerCase().trim();
  const existing = await User.findOne({ email: normalized });
  if (existing) return res.status(409).json({ error: 'email already registered' });

  // The very first account becomes the admin.
  const count = await User.countDocuments();
  const user = await User.create({
    name: String(name).trim(),
    email: normalized,
    password: String(password),
    role: count === 0 ? 'admin' : 'user',
  });

  return res.status(201).json({ token: signToken(user), user: user.toSafeJSON() });
});

/** POST /api/auth/login */
router.post('/login', authLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  const user = await User.findOne({ email: String(email).toLowerCase().trim() }).select(
    '+password'
  );
  if (!user || !(await user.verify(String(password)))) {
    return res.status(401).json({ error: 'invalid email or password' });
  }

  return res.json({ token: signToken(user), user: user.toSafeJSON() });
});

/** GET /api/auth/me */
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user.toSafeJSON() });
});

export default router;
