const CLIENT_ID   = import.meta.env.VITE_GOOGLE_CLIENT_ID;
const SCOPE       = 'https://www.googleapis.com/auth/drive email profile openid';
const TOKEN_KEY   = 'gauth_token';
const EXPIRY_KEY  = 'gauth_expiry';
const SCOPE_KEY   = 'gauth_scope';
const SCOPE_VER   = 'v4'; // bumped: forces re-consent to ensure drive scope is granted

let _tokenClient = null;

export function initGoogleAuth() {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) {
      _createTokenClient();
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => { _createTokenClient(); resolve(); };
    script.onerror = () => reject(new Error('Failed to load Google Identity Services'));
    document.head.appendChild(script);
  });
}

function _createTokenClient() {
  _tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPE,
    callback: '',
  });
}

export function isSignedIn() {
  const token  = localStorage.getItem(TOKEN_KEY);
  const expiry = parseInt(localStorage.getItem(EXPIRY_KEY) || '0', 10);
  const scope  = localStorage.getItem(SCOPE_KEY);
  if (token && Date.now() < expiry - 60_000 && scope === SCOPE_VER) {
    return true;
  }
  return false;
}

export function getAccessToken() {
  return isSignedIn() ? localStorage.getItem(TOKEN_KEY) : null;
}

export function requestSignIn() {
  return new Promise((resolve, reject) => {
    if (!_tokenClient) { reject(new Error('Google Auth not initialized')); return; }
    _tokenClient.callback = (response) => {
      if (response.error) { reject(new Error(response.error)); return; }
      localStorage.setItem(TOKEN_KEY, response.access_token);
      localStorage.setItem(EXPIRY_KEY, String(Date.now() + response.expires_in * 1000));
      localStorage.setItem(SCOPE_KEY, SCOPE_VER);
      resolve();
    };
    // prompt: '' reuses existing consent silently; 'consent' forces the picker
    _tokenClient.requestAccessToken({ prompt: isSignedIn() ? '' : 'consent' });
  });
}

export function signOut() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) google.accounts.oauth2.revoke(token, () => {});
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(EXPIRY_KEY);
  localStorage.removeItem(SCOPE_KEY);
}
