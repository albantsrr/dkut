import { getAccessToken } from './googleAuth.js';

const DRIVE_API  = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

// Typed error so callers can distinguish auth failures from generic Drive errors.
export class DriveAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DriveAuthError';
  }
}

async function driveRequest(path, options = {}, _attempt = 0) {
  const token = getAccessToken();
  if (!token) throw new Error('Not authenticated');
  const res = await fetch(`${DRIVE_API}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      ...options.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 403) {
      try {
        const data = JSON.parse(text);
        if (data?.error?.details?.some(d => d.reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT')) {
          // Token lacks Drive scope. Do NOT clear localStorage here — signOut() in
          // the caller needs the token to revoke it server-side before clearing.
          throw new DriveAuthError(`Drive API 403: ${text}`);
        }
      } catch (e) {
        if (e instanceof DriveAuthError) throw e;
        // JSON parse failed — fall through to retry / generic error
      }
    }
    // Retry once on 401 / non-scope 403: Google's distributed infrastructure can
    // return these transiently right after a fresh token is issued (propagation lag).
    if (_attempt === 0 && (res.status === 401 || res.status === 403)) {
      await new Promise(r => setTimeout(r, 1200));
      return driveRequest(path, options, 1);
    }
    throw new Error(`Drive API ${res.status}: ${text}`);
  }
  return res;
}

// Resumable upload — works for any file size
export async function uploadFile(parentId, filename, blob, mimeType) {
  const token = getAccessToken();
  if (!token) throw new Error('Not authenticated');

  const metadata = { name: filename, parents: [parentId] };
  const initRes = await fetch(`${UPLOAD_API}/files?uploadType=resumable`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Upload-Content-Type': mimeType,
      'X-Upload-Content-Length': String(blob.size),
    },
    body: JSON.stringify(metadata),
  });
  if (!initRes.ok) throw new Error(`Drive initiate upload ${initRes.status}`);
  const uploadUrl = initRes.headers.get('Location');

  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': mimeType },
    body: blob,
  });
  if (!uploadRes.ok) throw new Error(`Drive upload PUT ${uploadRes.status}`);
  return uploadRes.json();
}

// Download file content as ArrayBuffer
export async function downloadFile(fileId) {
  const res = await driveRequest(`/files/${fileId}?alt=media`);
  return res.arrayBuffer();
}

export async function deleteFile(fileId) {
  const token = getAccessToken();
  if (!token) throw new Error('Not authenticated');
  const res = await fetch(`${DRIVE_API}/files/${fileId}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok && res.status !== 204) throw new Error(`Drive DELETE ${res.status}`);
}

// Replace a file's content with new JSON
export async function updateJsonFile(fileId, data) {
  const token = getAccessToken();
  if (!token) throw new Error('Not authenticated');
  const body = JSON.stringify(data);
  const res = await fetch(`${UPLOAD_API}/files/${fileId}?uploadType=media`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body,
  });
  if (!res.ok) throw new Error(`Drive PATCH JSON ${res.status}`);
  return res.json();
}

export async function downloadJsonFile(fileId) {
  const res = await driveRequest(`/files/${fileId}?alt=media`);
  return res.json();
}

// List files inside a specific folder
export async function listFiles(folderId, extraQuery = '') {
  const q = `'${folderId}' in parents and trashed=false${extraQuery ? ' and ' + extraQuery : ''}`;
  const params = new URLSearchParams({
    q,
    fields: 'files(id,name,mimeType)',
    pageSize: '1000',
  });
  const res = await driveRequest(`/files?${params}`);
  const data = await res.json();
  return data.files;
}

// Search anywhere in Drive (used to find root-level app folder)
export async function searchFiles(query) {
  const params = new URLSearchParams({
    q: query,
    fields: 'files(id,name,mimeType)',
    pageSize: '10',
  });
  const res = await driveRequest(`/files?${params}`);
  const data = await res.json();
  return data.files;
}

export async function createFolder(name, parentId = null) {
  const token = getAccessToken();
  if (!token) throw new Error('Not authenticated');
  const metadata = {
    name,
    mimeType: 'application/vnd.google-apps.folder',
    ...(parentId ? { parents: [parentId] } : {}),
  };
  const res = await fetch(`${DRIVE_API}/files`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(metadata),
  });
  if (!res.ok) throw new Error(`Drive create folder ${res.status}`);
  return res.json();
}
