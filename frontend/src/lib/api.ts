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
      } else {
        const data = await retry.json().catch(() => ({}));
        throw new ApiError(data.detail || 'Request failed', retry.status, data);
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
      setTokens(
        data.tokens.access_token,
        data.tokens.refresh_token || refreshToken
      );
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

  logout: () => {
    const refreshToken = getRefreshToken();
    return request(`${AUTH_BASE}/auth/logout`, {
      method: 'POST',
      body: refreshToken ? JSON.stringify({ refresh_token: refreshToken }) : undefined,
    });
  },

  getMe: () => request(`${AUTH_BASE}/auth/me`),

  updateProfile: (data: { username?: string; avatar_url?: string }) =>
    request(`${AUTH_BASE}/auth/me`, { method: 'PUT', body: JSON.stringify(data) }),
};

/* ── File API ── */
export const fileApi = {
  shareFolder: (folderId: string, email: string, role: string) =>
    request(`${FILE_BASE}/folders/${folderId}/share`, {
      method: 'POST',
      body: JSON.stringify({ user_email: email, role }),
    }),
  getSharedFolders: () =>
    request(`${FILE_BASE}/folders/shared-with-me`),
  upload: async (file: File | Blob, folderId?: string, relativePath?: string, isEncrypted?: boolean) => {
    const formData = new FormData();
    // Support Blob (encrypted) by passing a name
    formData.append('file', file, (file as File).name || 'encrypted_blob');
    if (folderId) formData.append('folder_id', folderId);
    if (relativePath) formData.append('relative_path', relativePath);
    if (isEncrypted) formData.append('is_encrypted', 'true');
    
    return request(`${FILE_BASE}/files/upload`, { method: 'POST', body: formData });
  },

  uploadWithProgress: async (
    file: File,
    folderId: string | undefined,
    relativePath: string | undefined,
    onProgress: (percent: number) => void,
    signal?: AbortSignal,
  ) => {
    const uploadOnce = () => new Promise<Record<string, unknown>>((resolve, reject) => {
      const formData = new FormData();
      formData.append('file', file, file.name);
      if (folderId) formData.append('folder_id', folderId);
      if (relativePath) formData.append('relative_path', relativePath);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${FILE_BASE}/files/upload`);
      const token = getToken();
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
      };
      xhr.onload = () => {
        const data = JSON.parse(xhr.responseText || '{}');
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new ApiError(data.detail || 'Upload failed', xhr.status, data));
      };
      xhr.onerror = () => reject(new ApiError('Network error during upload', 0));
      xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
      signal?.addEventListener('abort', () => xhr.abort(), { once: true });
      xhr.send(formData);
    });

    try {
      return await uploadOnce();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401 && await refreshAccessToken()) {
        return uploadOnce();
      }
      throw error;
    }
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

export interface Project {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: 'active' | 'suspended' | 'archived';
  storage_quota: number;
  storage_used: number;
  max_file_size: number;
  warning_percent: number;
  retention_policy: Record<string, unknown> | null;
  member_role: 'viewer' | 'editor' | 'admin' | null;
  is_pinned: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface ProjectUsage {
  project_id: string;
  storage_used: number;
  storage_quota: number;
  available_bytes: number;
  percentage: number;
  warning_percent: number;
}

export interface ProjectFileFilters {
  q?: string;
  artifact_type?: string;
  starred?: boolean;
  sort_by?: 'created_at' | 'updated_at' | 'name' | 'size' | 'artifact_type';
  sort_order?: 'asc' | 'desc';
}

export interface ProjectFile {
  id: string;
  project_id: string;
  original_name: string;
  mime_type: string;
  size: number;
  checksum_sha256: string;
  status: string;
  is_deleted: boolean;
  deleted_at: string | null;
  is_starred: boolean;
  metadata: Record<string, unknown>;
  retention_until: string | null;
  created_at: string;
  updated_at: string;
  project_name?: string;
  project_slug?: string;
}

export interface ProjectMember {
  id: string;
  project_id: string;
  user_id: string;
  role: 'viewer' | 'editor' | 'admin';
  username: string;
  email: string;
  created_at: string;
}

export interface ServiceAccount {
  id: string;
  project_id: string;
  name: string;
  token_prefix: string | null;
  scopes: string[];
  is_active: boolean;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
  token?: string;
}

/* ── Project API ── */
export const projectApi = {
  list: () => request<Project[]>(`${AUTH_BASE}/projects`),

  get: (projectId: string) =>
    request<Project>(`${AUTH_BASE}/projects/${projectId}`),

  create: (data: {
    slug: string;
    name: string;
    description?: string;
    storage_quota: number;
    max_file_size: number;
    warning_percent: number;
    retention_policy?: Record<string, unknown>;
  }) => request<Project>(`${AUTH_BASE}/projects`, {
    method: 'POST', body: JSON.stringify(data),
  }),

  update: (projectId: string, data: {
    name?: string;
    description?: string;
    status?: 'active' | 'suspended';
    storage_quota?: number;
    max_file_size?: number;
    warning_percent?: number;
    retention_policy?: Record<string, unknown>;
  }) => request<Project>(`${AUTH_BASE}/projects/${projectId}`, {
    method: 'PUT', body: JSON.stringify(data),
  }),

  archive: (projectId: string) =>
    request<Project>(`${AUTH_BASE}/projects/${projectId}/archive`, { method: 'POST' }),

  restore: (projectId: string) =>
    request<Project>(`${AUTH_BASE}/projects/${projectId}/restore`, { method: 'POST' }),

  delete: (projectId: string, confirmSlug: string) =>
    request<void>(`${AUTH_BASE}/projects/${projectId}`, {
      method: 'DELETE', body: JSON.stringify({ confirm_slug: confirmSlug }),
    }),

  pin: (projectId: string) =>
    request<Project>(`${AUTH_BASE}/projects/${projectId}/pin`, { method: 'POST' }),

  unpin: (projectId: string) =>
    request<Project>(`${AUTH_BASE}/projects/${projectId}/pin`, { method: 'DELETE' }),

  getUsage: (projectId: string) =>
    request<ProjectUsage>(`${FILE_BASE}/projects/${projectId}/usage`),

  listFiles: (projectId: string, filters: ProjectFileFilters = {}) => {
    const query = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => {
      if (value !== undefined && value !== '') query.set(key, String(value));
    });
    const suffix = query.size ? `?${query.toString()}` : '';
    return request<{ files: ProjectFile[]; limit: number; offset: number; total: number }>(
      `${FILE_BASE}/projects/${projectId}/files${suffix}`
    );
  },

  listTrash: (projectId: string) =>
    request<{ files: ProjectFile[]; limit: number; offset: number }>(
      `${FILE_BASE}/projects/${projectId}/files/trash`
    ),

  uploadWithProgress: async (
    projectId: string,
    file: File,
    metadata: Record<string, unknown>,
    onProgress: (percent: number) => void,
    signal?: AbortSignal,
  ) => {
    const idempotencyKey = crypto.randomUUID();
    const uploadOnce = () => new Promise<ProjectFile>((resolve, reject) => {
      const formData = new FormData();
      formData.append('file', file, file.name);
      formData.append('metadata_json', JSON.stringify(metadata));

      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${FILE_BASE}/projects/${projectId}/files/upload`);
      const token = getToken();
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.setRequestHeader('Idempotency-Key', idempotencyKey);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
      };
      xhr.onload = () => {
        const data = JSON.parse(xhr.responseText || '{}');
        if (xhr.status >= 200 && xhr.status < 300) resolve(data as ProjectFile);
        else {
          const detail = data.detail;
          const message = typeof detail === 'object' ? detail?.message : detail;
          reject(new ApiError(message || 'Upload failed', xhr.status, data));
        }
      };
      xhr.onerror = () => reject(new ApiError('Network error during upload', 0));
      xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
      signal?.addEventListener('abort', () => xhr.abort(), { once: true });
      xhr.send(formData);
    });

    try {
      return await uploadOnce();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401 && await refreshAccessToken()) {
        return uploadOnce();
      }
      throw error;
    }
  },

  downloadFile: async (projectId: string, fileId: string) => {
    const downloadOnce = () => fetch(
      `${FILE_BASE}/projects/${projectId}/files/${fileId}/download`,
      { headers: { Authorization: `Bearer ${getToken() || ''}` }, cache: 'no-store' },
    );
    let response = await downloadOnce();
    if (response.status === 401 && await refreshAccessToken()) response = await downloadOnce();
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const detail = data.detail;
      const message = typeof detail === 'object' ? detail?.message : detail;
      throw new ApiError(message || 'Download failed', response.status, data);
    }
    return response.blob();
  },

  deleteFile: (projectId: string, fileId: string) =>
    request(`${FILE_BASE}/projects/${projectId}/files/${fileId}`, { method: 'DELETE' }),

  restoreFile: (projectId: string, fileId: string) =>
    request<ProjectFile>(`${FILE_BASE}/projects/${projectId}/files/${fileId}/restore`, {
      method: 'POST',
    }),

  permanentlyDeleteFile: (projectId: string, fileId: string) =>
    request<{ detail: string; released_bytes: number }>(
      `${FILE_BASE}/projects/${projectId}/files/${fileId}/permanent`,
      { method: 'DELETE' },
    ),

  starFile: (projectId: string, fileId: string) =>
    request<{ file_id: string; is_starred: boolean }>(
      `${FILE_BASE}/projects/${projectId}/files/${fileId}/star`,
      { method: 'POST' },
    ),

  unstarFile: (projectId: string, fileId: string) =>
    request<{ file_id: string; is_starred: boolean }>(
      `${FILE_BASE}/projects/${projectId}/files/${fileId}/star`,
      { method: 'DELETE' },
    ),

  listStarredFiles: () =>
    request<{ files: ProjectFile[] }>(`${FILE_BASE}/files/project-starred`),

  bulkStarFiles: (projectId: string, fileIds: string[], starred: boolean) =>
    request<{ file_ids: string[]; is_starred: boolean }>(
      `${FILE_BASE}/projects/${projectId}/files/bulk-star`,
      { method: 'POST', body: JSON.stringify({ file_ids: fileIds, starred }) },
    ),

  bulkDeleteFiles: (projectId: string, fileIds: string[]) =>
    request<{ file_ids: string[]; detail: string }>(
      `${FILE_BASE}/projects/${projectId}/files/bulk-delete`,
      { method: 'POST', body: JSON.stringify({ file_ids: fileIds }) },
    ),

  listMembers: (projectId: string) =>
    request<ProjectMember[]>(`${AUTH_BASE}/projects/${projectId}/members`),

  addMember: (projectId: string, userId: string, role: ProjectMember['role']) =>
    request<ProjectMember>(`${AUTH_BASE}/projects/${projectId}/members`, {
      method: 'POST', body: JSON.stringify({ user_id: userId, role }),
    }),

  updateMember: (projectId: string, memberId: string, role: ProjectMember['role']) =>
    request<ProjectMember>(`${AUTH_BASE}/projects/${projectId}/members/${memberId}`, {
      method: 'PUT', body: JSON.stringify({ role }),
    }),

  removeMember: (projectId: string, memberId: string) =>
    request(`${AUTH_BASE}/projects/${projectId}/members/${memberId}`, { method: 'DELETE' }),

  listServiceAccounts: (projectId: string) =>
    request<ServiceAccount[]>(`${AUTH_BASE}/projects/${projectId}/service-accounts`),

  createServiceAccount: (projectId: string, data: { name: string; scopes: string[] }) =>
    request<ServiceAccount>(`${AUTH_BASE}/projects/${projectId}/service-accounts`, {
      method: 'POST', body: JSON.stringify(data),
    }),

  rotateServiceAccount: (projectId: string, accountId: string) =>
    request<ServiceAccount>(
      `${AUTH_BASE}/projects/${projectId}/service-accounts/${accountId}/rotate`,
      { method: 'POST' },
    ),

  revokeServiceAccount: (projectId: string, accountId: string) =>
    request(
      `${AUTH_BASE}/projects/${projectId}/service-accounts/${accountId}`,
      { method: 'DELETE' },
    ),
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

  search: (params: {
    q: string; page?: number; pageSize?: number; mimeType?: string;
    minSize?: number; maxSize?: number; dateFrom?: string; dateTo?: string;
    sortBy?: 'relevance' | 'created_at' | 'updated_at' | 'size' | 'original_name';
    sortOrder?: 'asc' | 'desc';
  }) => {
    const qs = new URLSearchParams();
    qs.set('q', params.q);
    qs.set('page', String(params.page || 1));
    qs.set('page_size', String(params.pageSize || 20));
    if (params.mimeType) qs.set('mime_type', params.mimeType);
    if (params.minSize !== undefined) qs.set('min_size', String(params.minSize));
    if (params.maxSize !== undefined) qs.set('max_size', String(params.maxSize));
    if (params.dateFrom) qs.set('date_from', params.dateFrom);
    if (params.dateTo) qs.set('date_to', params.dateTo);
    if (params.sortBy) qs.set('sort_by', params.sortBy);
    if (params.sortOrder) qs.set('sort_order', params.sortOrder);
    return request(`${META_BASE}/search/?${qs.toString()}`);
  },

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
