import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { JWT_SECRET, JWT_TTL, usingDefaultSecret } from '../config/env.js';

const SECRET = JWT_SECRET;
const TTL = JWT_TTL;

export { usingDefaultSecret };

export function signToken(user) {
  return jwt.sign(
    { sub: user._id.toString(), role: user.role, name: user.name },
    SECRET,
    { expiresIn: TTL }
  );
}

export function verifyToken(token) {
  return jwt.verify(token, SECRET);
}

/** sha256 hex digest - device tokens are only stored hashed. */
export const sha256 = (value) =>
  crypto.createHash('sha256').update(String(value)).digest('hex');

/** Opaque, URL-safe device secret (shown once to the agent). */
export const randomDeviceToken = () => crypto.randomBytes(24).toString('base64url');

/** Human-typable, unambiguous enrollment code, e.g. "K7F2-9QMR". */
export function randomEnrollCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) {
    if (i === 4) out += '-';
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

/** AnyDesk-style 12 digit device id, e.g. "739 412 850 213". */
export function randomDeviceId() {
  const bytes = crypto.randomBytes(12);
  let out = '';
  for (let i = 0; i < 12; i++) {
    if (i > 0 && i % 3 === 0) out += ' ';
    out += String(bytes[i] % 10);
  }
  return out;
}
