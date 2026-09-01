import { SESSION_COOKIE, verifySession } from '../session.js';

// Attaches req.userId from the session cookie, or responds 401.
export default function requireAuth(req, res, next) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return res.status(401).json({ error: 'not_authenticated' });
  try {
    req.userId = verifySession(token);
    next();
  } catch {
    return res.status(401).json({ error: 'not_authenticated' });
  }
}
