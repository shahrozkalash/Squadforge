import React, { createContext, useContext, useState, useEffect } from 'react';
import { User } from '../types/index.js';

interface AuthContextType {
  user: User | null;
  loading: boolean;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<{ success: boolean; error?: string }>;
  register: (name: string, email: string, password: string, confirmPassword: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
  requestPasswordReset: (email: string) => Promise<{ 
    success: boolean; 
    message: string; 
    error?: string; 
    missingConfig?: boolean; 
    requiredEnv?: string[]; 
    cooldownSeconds?: number;
    devToken?: string;
  }>;
  resendVerificationCode: (email: string) => Promise<{
    success: boolean;
    message: string;
    error?: string;
    missingConfig?: boolean;
    requiredEnv?: string[];
    cooldownRemaining?: number;
  }>;
  verifyResetCode: (email: string, code: string) => Promise<{
    success: boolean;
    resetAuthToken?: string;
    message?: string;
    error?: string;
    codeExpiredOrInvalid?: boolean;
    attemptsRemaining?: number;
  }>;
  resetPassword: (
    token: string, 
    newPassword: string, 
    confirmPassword: string
  ) => Promise<{ success: boolean; message?: string; error?: string }>;
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
      } else {
        setUser(null);
      }
    } catch (err) {
      console.error('Failed to load user session:', err);
      setUser(null);
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
      if (!origin.endsWith('.run.app') && !origin.includes('localhost') && !origin.includes('0.0.0.0')) {
        return;
      }
      if (event.data?.type === 'OAUTH_AUTH_SUCCESS') {
        refreshUser();
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const login = async (email: string, password: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      if (!res.ok) {
        return { success: false, error: data.error || 'Invalid email or password.' };
      }
      setUser(data.user);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message || 'Network error occurred during login.' };
    }
  };

  const register = async (
    name: string, 
    email: string, 
    password: string, 
    confirmPassword: string
  ): Promise<{ success: boolean; error?: string }> => {
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password, confirmPassword })
      });
      const data = await res.json();
      if (!res.ok) {
        return { success: false, error: data.error || 'Failed to create account.' };
      }
      setUser(data.user);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message || 'Network error occurred during registration.' };
    }
  };

  const logout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch (err) {
      console.warn('Logout network error:', err);
    } finally {
      setUser(null);
    }
  };

  const requestPasswordReset = async (email: string): Promise<{ 
    success: boolean; 
    message: string; 
    error?: string; 
    missingConfig?: boolean;
    requiredEnv?: string[];
    cooldownSeconds?: number;
    devToken?: string;
  }> => {
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
      const data = await res.json();
      if (!res.ok) {
        return { 
          success: false, 
          message: '', 
          error: data.error || 'Failed to request password reset code.',
          missingConfig: data.missingConfig,
          requiredEnv: data.requiredEnv
        };
      }
      return { 
        success: true, 
        message: data.message || 'If an account exists, a verification code has been sent.',
        cooldownSeconds: data.cooldownSeconds || 60,
        devToken: data.devToken
      };
    } catch (err: any) {
      return { success: false, message: '', error: err.message || 'Network error occurred.' };
    }
  };

  const resendVerificationCode = async (email: string): Promise<{
    success: boolean;
    message: string;
    error?: string;
    missingConfig?: boolean;
    requiredEnv?: string[];
    cooldownRemaining?: number;
  }> => {
    try {
      const res = await fetch('/api/auth/resend-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
      const data = await res.json();
      if (!res.ok) {
        return {
          success: false,
          message: '',
          error: data.error || 'Failed to resend verification code.',
          missingConfig: data.missingConfig,
          requiredEnv: data.requiredEnv,
          cooldownRemaining: data.cooldownRemaining
        };
      }
      return {
        success: true,
        message: data.message || 'A new verification code has been sent.'
      };
    } catch (err: any) {
      return { success: false, message: '', error: err.message || 'Network error occurred.' };
    }
  };

  const verifyResetCode = async (
    email: string, 
    code: string
  ): Promise<{
    success: boolean;
    resetAuthToken?: string;
    message?: string;
    error?: string;
    codeExpiredOrInvalid?: boolean;
    attemptsRemaining?: number;
  }> => {
    try {
      const res = await fetch('/api/auth/verify-reset-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code })
      });
      const data = await res.json();
      if (!res.ok) {
        return {
          success: false,
          error: data.error || 'Verification code is invalid.',
          codeExpiredOrInvalid: data.codeExpiredOrInvalid,
          attemptsRemaining: data.attemptsRemaining
        };
      }
      return {
        success: true,
        resetAuthToken: data.resetAuthToken,
        message: data.message
      };
    } catch (err: any) {
      return { success: false, error: err.message || 'Network error occurred during verification.' };
    }
  };

  const resetPassword = async (
    tokenOrAuth: string, 
    newPassword: string, 
    confirmPassword: string
  ): Promise<{ success: boolean; message?: string; error?: string }> => {
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          resetAuthToken: tokenOrAuth,
          token: tokenOrAuth, 
          newPassword, 
          confirmPassword 
        })
      });
      const data = await res.json();
      if (!res.ok) {
        return { success: false, error: data.error || 'Failed to reset password.' };
      }
      return { success: true, message: data.message };
    } catch (err: any) {
      return { success: false, error: err.message || 'Network error occurred.' };
    }
  };

  const connectGitHubOAuth = async () => {
    try {
      const res = await fetch('/api/auth/github/url');
      if (!res.ok) throw new Error('Failed to get GitHub auth URL');
      const { url } = await res.json();

      const authWindow = window.open(
        url,
        'oauth_popup',
        'width=600,height=700,status=no,toolbar=no,menubar=no'
      );

      if (!authWindow) {
        console.warn('Popup blocked by browser. Please allow popups.');
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
      isAuthenticated: Boolean(user),
      login,
      register,
      logout,
      requestPasswordReset,
      resendVerificationCode,
      verifyResetCode,
      resetPassword,
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
