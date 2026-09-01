import { Router } from 'express';
import { pool } from '../db.js';
import { SESSION_COOKIE, signSession, sessionCookieOptions } from '../session.js';
import requireAuth from '../middleware/requireAuth.js';

const router = Router();

function toPublicUser(row) {
  return { sub: row.google_sub, name: row.name, email: row.email, picture: row.picture };
}

// Body: { accessToken } — the OAuth2 access token the frontend already holds
// from its existing Drive sign-in flow (src/lib/googleAuth.js). Verified two
// ways: tokeninfo confirms it was issued to *this* app's client id (so a
// token minted for another app can't be replayed here), then userinfo
// (authenticated with the token itself) supplies the profile fields.
//
// This is deliberately not an ID-token flow: the frontend still drives sign-in
// through the pre-existing Drive OAuth popup (kept alive because progress/
// prompts/quiz/pomodoro/notes are still Drive-backed pending a later phase),
// and this endpoint just piggybacks a backend session on top of it.
router.post('/auth/google', async (req, res) => {
  const { accessToken } = req.body ?? {};
  if (!accessToken) return res.status(400).json({ error: 'missing_access_token' });

  let tokenInfo;
  try {
    const infoRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`);
    if (!infoRes.ok) throw new Error('tokeninfo request failed');
    tokenInfo = await infoRes.json();
  } catch {
    return res.status(401).json({ error: 'invalid_access_token' });
  }

  if (tokenInfo.aud !== process.env.GOOGLE_CLIENT_ID && tokenInfo.azp !== process.env.GOOGLE_CLIENT_ID) {
    return res.status(401).json({ error: 'audience_mismatch' });
  }
  if (!tokenInfo.sub) return res.status(401).json({ error: 'missing_sub' });

  let profile;
  try {
    const profileRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!profileRes.ok) throw new Error('userinfo request failed');
    profile = await profileRes.json();
  } catch {
    return res.status(401).json({ error: 'invalid_access_token' });
  }

  const { sub, email, name, picture } = profile;
  const { rows } = await pool.query(
    `INSERT INTO users (google_sub, email, name, picture)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (google_sub) DO UPDATE
       SET email = EXCLUDED.email, name = EXCLUDED.name, picture = EXCLUDED.picture
     RETURNING id, google_sub, email, name, picture`,
    [sub, email, name, picture]
  );
  const user = rows[0];

  res.cookie(SESSION_COOKIE, signSession(user.id), sessionCookieOptions());
  res.json(toPublicUser(user));
});

router.post('/auth/logout', (req, res) => {
  res.clearCookie(SESSION_COOKIE, sessionCookieOptions());
  res.status(204).end();
});

router.get('/me', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT google_sub, email, name, picture FROM users WHERE id = $1',
    [req.userId]
  );
  if (rows.length === 0) return res.status(401).json({ error: 'not_authenticated' });
  res.json(toPublicUser(rows[0]));
});

export default router;
