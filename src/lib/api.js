// Thin fetch wrapper around the new backend (server/), introduced alongside
// the books API — see MIGRATION_PLAN.md. `credentials: 'include'` sends the
// httpOnly session cookie set by POST /auth/google.

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8787';

async function request(path, options = {}) {
  const res = await fetch(`${API_URL}${path}`, { credentials: 'include', ...options });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${options.method ?? 'GET'} ${path} failed (${res.status}): ${text}`);
  }
  return res;
}

export async function apiGet(path) {
  return (await request(path)).json();
}

export async function apiGetBuffer(path) {
  return (await request(path)).arrayBuffer();
}

export async function apiPostJson(path, body) {
  return (await request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })).json();
}

export async function apiPutJson(path, body) {
  await request(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function apiPost(path) {
  await request(path, { method: 'POST' });
}

export async function apiPostForm(path, formData) {
  return (await request(path, { method: 'POST', body: formData })).json();
}

export async function apiDelete(path) {
  await request(path, { method: 'DELETE' });
}
