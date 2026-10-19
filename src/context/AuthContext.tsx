import React, { createContext, useContext, useState, useEffect } from 'react';
import { User } from '../types/index.js';

interface AuthContextType {
  user: User | null;
  loading: boolean;
  login: (email: string, name?: string) => Promise<void>;
  logout: () => Promise<void>;
  connectGitHubOAuth: () => Promise<void>;
  connectGitHubPAT: (token: string, username?: string) => Promise<boolean>;
  disconnectGitHub: () => Promise<void>;
  updateSettings: (settings: Partial<User>) => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshUser = async () => {
    try {
      const res = await fetch('/api/auth/me');
      if (res.ok) {
        const data = await res.json();
        setUser(data.user);
      }
    } catch (err) {
      console.error('Failed to load user:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refreshUser();
  }, []);

  // Listen for OAuth postMessage from popup window per OAuth skill
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const origin = event.origin;
      if (!origin.endsWith('.run.app') && !origin.includes('localhost')) {
        return;
      }
      if (event.data?.type === 'OAUTH_AUTH_SUCCESS') {
        refreshUser();
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const login = async (email: string, name?: string) => {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, name: name || email.split('@')[0] })
    });
    if (res.ok) {
      const data = await res.json();
      setUser(data.user);
    }
  };

  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    setUser(null);
  };

  const connectGitHubOAuth = async () => {
    try {
      const res = await fetch('/api/auth/github/url');
      if (!res.ok) throw new Error('Failed to get GitHub auth URL');
      const { url } = await res.json();

      // Open OAuth provider directly in popup per OAuth skill
      const authWindow = window.open(
        url,
        'oauth_popup',
        'width=600,height=700,status=no,toolbar=no,menubar=no'
      );

      if (!authWindow) {
        alert('Please allow popups for this site to connect GitHub.');
      }
    } catch (err) {
      console.error('OAuth initiation error:', err);
    }
  };

  const connectGitHubPAT = async (token: string, username?: string): Promise<boolean> => {
    try {
      const res = await fetch('/api/auth/github/connect-pat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, username })
      });
      if (res.ok) {
        await refreshUser();
        return true;
      }
      return false;
    } catch (err) {
      console.error('Error connecting PAT:', err);
      return false;
    }
  };

  const disconnectGitHub = async () => {
    await fetch('/api/auth/github/disconnect', { method: 'POST' });
    await refreshUser();
  };

  const updateSettings = async (settings: Partial<User>) => {
    const res = await fetch('/api/user/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    });
    if (res.ok) {
      const data = await res.json();
      setUser(data.user);
    }
  };

  return (
    <AuthContext.Provider value={{
      user,
      loading,
      login,
      logout,
      connectGitHubOAuth,
      connectGitHubPAT,
      disconnectGitHub,
      updateSettings,
      refreshUser
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
};
