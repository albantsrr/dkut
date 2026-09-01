import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import {
  initGoogleAuth, isSignedIn, requestSignIn,
  signOut as gSignOut, getAccessToken,
} from '../lib/googleAuth.js';
import { resetProgress } from '../lib/progress.js';
import { resetCustomPrompts } from '../lib/customPrompts.js';
import { resetQuizProgress } from '../lib/quizProgress.js';
import { resetPomodoroLog } from '../lib/pomodoroLog.js';
import { clearAllCache } from '../lib/bookCache.js';
import { apiPostJson, apiPost } from '../lib/api.js';

const AuthContext = createContext(null);

async function fetchUserInfo() {
  const token = getAccessToken();
  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) throw new Error('Failed to fetch user info');
  return res.json(); // { sub, name, email, picture }
}

// Piggybacks a backend session (server/) on top of the existing Google OAuth
// access token — see server/src/routes/auth.js. Sign-in itself still goes
// through the original Drive OAuth2 popup (src/lib/googleAuth.js): the
// backend never needed a competing ID-token/GIS-button flow, it just needed
// a token to verify. The `drive` scope that flow still requests is now wider
// than anything in this app actually calls (everything migrated off Drive as
// of MIGRATION_PLAN.md phase 3) — narrowing it is a separate cleanup, not
// done here since it requires a SCOPE_VER bump and forces re-consent for
// every signed-in user. A failure here must never block sign-in itself.
async function establishBackendSession() {
  try {
    await apiPostJson('/auth/google', { accessToken: getAccessToken() });
  } catch (err) {
    console.error('[AuthContext] backend session sync failed:', err);
  }
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
          await establishBackendSession();
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
    await establishBackendSession();
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
    await apiPost('/auth/logout').catch(() => {});
    resetProgress();
    resetCustomPrompts();
    resetQuizProgress();
    resetPomodoroLog();
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
