/**
 * CloudVault — Auth Context
 * Global auth state management with React Context.
 */
'use client';

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { authApi, setTokens, clearTokens, getToken } from '@/lib/api';

interface User {
  id: string;
  email: string;
  username: string;
  avatar_url: string | null;
  role: 'user' | 'admin';
  storage_quota: number;
  storage_used: number;
  created_at: string;
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshUser = useCallback(async () => {
    try {
      const token = getToken();
      if (!token) { setUser(null); return; }
      const data = await authApi.getMe() as { user: User };
      setUser(data.user || data as unknown as User);
    } catch {
      setUser(null);
      clearTokens();
    }
  }, []);

  useEffect(() => {
    refreshUser().finally(() => setLoading(false));
  }, [refreshUser]);

  const login = async (email: string, password: string) => {
    const data = await authApi.login({ email, password }) as {
      tokens: { access_token: string; refresh_token: string };
      user: User;
    };
    setTokens(data.tokens.access_token, data.tokens.refresh_token);
    setUser(data.user);
  };

  const register = async (email: string, username: string, password: string) => {
    const data = await authApi.register({ email, username, password }) as {
      tokens: { access_token: string; refresh_token: string };
      user: User;
    };
    setTokens(data.tokens.access_token, data.tokens.refresh_token);
    setUser(data.user);
  };

  const logout = async () => {
    try { await authApi.logout(); } catch { /* ok */ }
    clearTokens();
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
