/**
 * Centralised environment parsing + validation.
 *
 * Deployments fail fast here instead of starting an insecure/partly-configured
 * service: production refuses to boot without a real JWT secret.
 */

export const NODE_ENV = process.env.NODE_ENV || 'development';
export const isProduction = NODE_ENV === 'production';

const DEV_SECRET = 'insecure-dev-secret-change-me';
export const JWT_SECRET = process.env.JWT_SECRET || DEV_SECRET;
export const JWT_TTL = process.env.JWT_TTL || '7d';
export const usingDefaultSecret = () => JWT_SECRET === DEV_SECRET;

export const PORT = (() => {
  const parsed = Number.parseInt(process.env.PORT ?? '', 10);
  // Some shells export PORT=0 (or garbage) - only trust a real TCP port.
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : 5000;
})();

/** Comma-separated list of browser origins allowed to use the API + websocket. */
export const ALLOWED_ORIGINS = (process.env.CLIENT_ORIGIN || (isProduction ? '' : 'http://localhost:5173'))
  .split(',')
  .map((origin) => origin.trim().replace(/\/+$/, ''))
  .filter(Boolean);

export const TRUST_PROXY =
  process.env.TRUST_PROXY === '1' || (isProduction && process.env.TRUST_PROXY !== '0');

/**
 * A browser origin is allowed when it is listed in CLIENT_ORIGIN, when it is
 * the same host as the request (single-origin deployment), or when it is
 * missing (native agents, curl, health checks, mobile webviews).
 */
export function isAllowedOrigin(origin, host) {
  if (!origin) return true;
  const normalized = String(origin).replace(/\/+$/, '');
  if (ALLOWED_ORIGINS.includes(normalized)) return true;
  try {
    return new URL(normalized).host === host;
  } catch {
    return false;
  }
}

/** Runs at import time so a misconfigured production deploy never listens. */
export function assertValidEnvironment() {
  if (isProduction && usingDefaultSecret()) {
    throw new Error(
      'JWT_SECRET must be set to a long random value when NODE_ENV=production'
    );
  }
  if (isProduction && !process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI must be set when NODE_ENV=production');
  }
}

assertValidEnvironment();
