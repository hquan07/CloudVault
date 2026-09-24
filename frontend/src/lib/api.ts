/**
 * CloudVault — API Client
 * Centralized HTTP client for all backend service calls.
 */

const AUTH_BASE = process.env.NEXT_PUBLIC_AUTH_URL || '/api/v1';
const FILE_BASE = process.env.NEXT_PUBLIC_FILE_URL || '/api/v1';
const META_BASE = process.env.NEXT_PUBLIC_META_URL || '/api/v1';

class ApiError extends Error {
  status: number;
  data: Record<string, unknown>;
  constructor(message: string, status: number, data: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('cloudvault_access_token');
}

function getRefreshToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('cloudvault_refresh_token');
}

function setTokens(access: string, refresh: string) {
  localStorage.setItem('cloudvault_access_token', access);
  localStorage.setItem('cloudvault_refresh_token', refresh);
}

function clearTokens() {
  localStorage.removeItem('cloudvault_access_token');
  localStorage.removeItem('cloudvault_refresh_token');
}

async function request<T = unknown>(
  url: string,
  options: RequestInit = {},
  auth = true
): Promise<T> {
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> || {}),
  };

  if (auth) {
    const token = getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }

  if (!(options.body instanceof FormData)) {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  }

  const res = await fetch(url, { ...options, headers, cache: 'no-store' });

  if (res.status === 401 && auth) {
    // Try refresh
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      headers['Authorization'] = `Bearer ${getToken()}`;
      const retry = await fetch(url, { ...options, headers, cache: 'no-store' });
      if (retry.ok) {
        return retry.status === 204 ? (undefined as T) : await retry.json();
      }
    }
    clearTokens();
    window.location.href = '/';
    throw new ApiError('Unauthorized', 401);
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(data.detail || 'Request failed', res.status, data);
  }

  if (res.status === 204) return undefined as T;
  return await res.json();
}

async function refreshAccessToken(): Promise<boolean> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;
  try {
    const res = await fetch(`${AUTH_BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (res.ok) {
      const data = await res.json();
      setTokens(data.access_token, data.refresh_token || refreshToken);
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

/* ── Auth API ── */
export const authApi = {
  register: (data: { email: string; username: string; password: string }) =>
    request(`${AUTH_BASE}/auth/register`, { method: 'POST', body: JSON.stringify(data) }, false),

  login: (data: { email: string; password: string }) =>
    request(`${AUTH_BASE}/auth/login`, { method: 'POST', body: JSON.stringify(data) }, false),

  logout: () => request(`${AUTH_BASE}/auth/logout`, { method: 'POST' }),

  getMe: () => request(`${AUTH_BASE}/auth/me`),

  updateProfile: (data: { username?: string; avatar_url?: string }) =>
    request(`${AUTH_BASE}/auth/me`, { method: 'PUT', body: JSON.stringify(data) }),
};

/* ── File API ── */
export const fileApi = {
  upload: async (file: File | Blob, folderId?: string, relativePath?: string, isEncrypted?: boolean) => {
    const formData = new FormData();
    // Support Blob (encrypted) by passing a name
    formData.append('file', file, (file as File).name || 'encrypted_blob');
    if (folderId) formData.append('folder_id', folderId);
    if (relativePath) formData.append('relative_path', relativePath);
    if (isEncrypted) formData.append('is_encrypted', 'true');
    
    return request(`${FILE_BASE}/files/upload`, { method: 'POST', body: formData });
  },

  download: async (fileId: string) => {
    return request<{ download_url: string }>(`${FILE_BASE}/files/${fileId}/download`);
  },

  getVersions: (fileId: string) =>
    request<any[]>(`${FILE_BASE}/files/${fileId}/versions`),

  restoreVersion: (fileId: string, versionNumber: number) =>
    request(`${FILE_BASE}/files/${fileId}/versions/restore`, {
      method: 'POST', body: JSON.stringify({ version_number: versionNumber }),
    }),

  deleteFile: (fileId: string) =>
    request(`${FILE_BASE}/files/${fileId}`, { method: 'DELETE' }),

  getTrash: () => request(`${FILE_BASE}/files/trash/list`),

  permanentDelete: (fileId: string) =>
    request(`${FILE_BASE}/files/${fileId}/permanent`, { method: 'DELETE' }),

  restore: (fileId: string) =>
    request(`${FILE_BASE}/files/${fileId}/restore`, { method: 'POST' }),

  copy: (fileId: string, folderId?: string) =>
    request(`${FILE_BASE}/files/${fileId}/copy`, {
      method: 'POST', body: JSON.stringify({ folder_id: folderId }),
    }),

  move: (fileId: string, folderId: string) =>
    request(`${FILE_BASE}/files/${fileId}/move`, {
      method: 'POST', body: JSON.stringify({ folder_id: folderId }),
    }),

  createFolder: (name: string, parentId?: string) =>
    request(`${FILE_BASE}/folders`, {
      method: 'POST', body: JSON.stringify({ name, parent_id: parentId }),
    }),

  listFolders: (parentId?: string) =>
    request(`${FILE_BASE}/folders${parentId ? `?parent_id=${parentId}` : ''}`),
};

/* ── Metadata API ── */
export const metaApi = {
  listFiles: (params: Record<string, string | number | boolean>) => {
    const qs = new URLSearchParams(
      Object.entries(params).map(([k, v]) => [k, String(v)])
    ).toString();
    return request(`${META_BASE}/metadata/files?${qs}`);
  },

  getFile: (fileId: string) =>
    request(`${META_BASE}/metadata/files/${fileId}`),

  updateFile: (fileId: string, data: { original_name?: string; is_starred?: boolean }) =>
    request(`${META_BASE}/metadata/files/${fileId}`, {
      method: 'PUT', body: JSON.stringify(data),
    }),

  getVersions: (fileId: string) =>
    request(`${META_BASE}/metadata/files/${fileId}/versions`),

  getStorage: () => request(`${META_BASE}/metadata/storage`),

  search: (q: string, page = 1, pageSize = 20) =>
    request(`${META_BASE}/search/?q=${encodeURIComponent(q)}&page=${page}&page_size=${pageSize}`),

  suggest: (q: string) =>
    request(`${META_BASE}/search/suggest?q=${encodeURIComponent(q)}`),

  getActivity: (page = 1, pageSize = 20) =>
    request(`${META_BASE}/activity?page=${page}&page_size=${pageSize}`),
};

/* ── Admin API ── */
export const adminApi = {
  getStats: () => request(`${AUTH_BASE}/admin/stats`),
  getMetadataStats: () => request(`${META_BASE}/metadata/admin/stats`),
  getUsers: () => request(`${AUTH_BASE}/admin/users`),
  updateRole: (userId: string, role: string) => 
    request(`${AUTH_BASE}/admin/users/${userId}/role`, { method: 'PUT', body: JSON.stringify({ role }) }),
  updateQuota: (userId: string, quota: number) => 
    request(`${AUTH_BASE}/admin/users/${userId}/quota`, { method: 'PUT', body: JSON.stringify({ storage_quota: quota }) }),
  updateStatus: (userId: string, isActive: boolean) => 
    request(`${AUTH_BASE}/admin/users/${userId}/status`, { method: 'PUT', body: JSON.stringify({ is_active: isActive }) }),
};

/* ── Sharing API ── */
export const shareApi = {
  createLink: (data: { file_id: string; password?: string; expires_in_days?: number; max_downloads?: number }) =>
    request(`${META_BASE}/share/`, { method: 'POST', body: JSON.stringify(data) }),

  accessPublic: (token: string) =>
    request(`${META_BASE}/share/access/${token}`, {}, false),

  accessWithPassword: (token: string, password: string) =>
    request(`${META_BASE}/share/access/${token}`, {
      method: 'POST', body: JSON.stringify({ password }),
    }, false),

  listMyLinks: (page = 1) =>
    request(`${META_BASE}/share/links/mine?page=${page}`),

  listFileLinks: (fileId: string) =>
    request(`${META_BASE}/share/links/file/${fileId}`),

  revokeLink: (linkId: string) =>
    request(`${META_BASE}/share/links/${linkId}`, { method: 'DELETE' }),
};

export { setTokens, clearTokens, getToken, ApiError };
