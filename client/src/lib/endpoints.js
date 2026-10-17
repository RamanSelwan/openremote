const trim = (value) => String(value || '').trim().replace(/\/+$/, '');

/**
 * Empty API_BASE means "same origin" (/api is proxied by Vite in development
 * and served by Express in a single-origin deployment). On Vercel, point
 * VITE_API_URL at the Render service instead.
 */
export const API_BASE = trim(import.meta.env.VITE_API_URL);

/** Socket.IO server. Defaults to the page origin. */
export const SERVER_URL =
  trim(import.meta.env.VITE_SERVER_URL) ||
  (typeof window !== 'undefined' ? window.location.origin : '');
