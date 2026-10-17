import { API_BASE } from './endpoints.js';

const TOKEN_KEY = 'openremote.token';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (token) => localStorage.setItem(TOKEN_KEY, token);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

/**
 * Small fetch wrapper for /api/*.
 * On 401 the token is dropped and a global event fires so AuthContext can log out.
 */
export async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';

  const res = await fetch(`${API_BASE}/api${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON response */
  }

  if (res.status === 401) {
    clearToken();
    window.dispatchEvent(new Event('openremote:unauthorized'));
  }
  if (!res.ok) {
    throw new Error(data?.error || `Request failed (HTTP ${res.status})`);
  }
  return data;
}
