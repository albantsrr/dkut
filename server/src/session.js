import jwt from 'jsonwebtoken';

export const SESSION_COOKIE = 'session';
const SESSION_TTL = '7d';

export function signSession(userId) {
  return jwt.sign({ sub: userId }, process.env.SESSION_SECRET, { expiresIn: SESSION_TTL });
}

// Throws if the token is missing, expired, or forged.
export function verifySession(token) {
  const payload = jwt.verify(token, process.env.SESSION_SECRET);
  return payload.sub;
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
}
