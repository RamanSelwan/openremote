import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { api, clearToken, getToken, setToken } from '../lib/api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function boot() {
      if (!getToken()) {
        setLoading(false);
        return;
      }
      try {
        const data = await api('/auth/me');
        if (!cancelled) setUser(data.user);
      } catch {
        clearToken();
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    const onUnauthorized = () => setUser(null);
    boot();
    window.addEventListener('openremote:unauthorized', onUnauthorized);
    return () => {
      cancelled = true;
      window.removeEventListener('openremote:unauthorized', onUnauthorized);
    };
  }, []);

  const login = useCallback(async (email, password) => {
    const data = await api('/auth/login', {
      method: 'POST',
      body: { email, password },
    });
    setToken(data.token);
    setUser(data.user);
    return data.user;
  }, []);

  const register = useCallback(async (name, email, password) => {
    const data = await api('/auth/register', {
      method: 'POST',
      body: { name, email, password },
    });
    setToken(data.token);
    setUser(data.user);
    return data.user;
  }, []);

  const logout = useCallback(() => {
    clearToken();
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ user, loading, login, register, logout }),
    [user, loading, login, register, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
