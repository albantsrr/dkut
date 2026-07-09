import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import {
  initGoogleAuth, isSignedIn, requestSignIn,
  signOut as gSignOut, getAccessToken,
} from '../lib/googleAuth.js';
import { resetDriveStorage } from '../lib/driveStorage.js';
import { resetProgress } from '../lib/progress.js';
import { resetCustomPrompts } from '../lib/customPrompts.js';
import { clearAllCache } from '../lib/bookCache.js';

const AuthContext = createContext(null);

async function fetchUserInfo() {
  const token = getAccessToken();
  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) throw new Error('Failed to fetch user info');
  return res.json(); // { sub, name, email, picture }
}

export function AuthProvider({ children }) {
  const [user, setUser]       = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function init() {
      try {
        await initGoogleAuth();
        if (isSignedIn()) {
          const info = await fetchUserInfo();
          setUser(info);
        }
      } catch (err) {
        // Stored token may be invalid — clear it silently
        gSignOut();
      } finally {
        setLoading(false);
      }
    }
    init();
  }, []);

  const signIn = useCallback(async () => {
    await requestSignIn();
    const info = await fetchUserInfo();
    setUser(info);
  }, []);

  // Proactively refresh the OAuth token when it approaches expiry (within 10 min).
  // requestSignIn uses prompt:'' (silent) when isSignedIn() is still true, so no popup.
  useEffect(() => {
    if (!user) return;
    const check = async () => {
      const expiry = parseInt(localStorage.getItem('gauth_expiry') || '0', 10);
      if (expiry > 0 && Date.now() > expiry - 10 * 60_000 && isSignedIn()) {
        try { await signIn(); } catch {}
      }
    };
    const interval = setInterval(check, 60_000);
    return () => clearInterval(interval);
  }, [user, signIn]);

  const signOut = useCallback(async () => {
    gSignOut();
    resetDriveStorage();
    resetProgress();
    resetCustomPrompts();
    await clearAllCache();
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
