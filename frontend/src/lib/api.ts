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

let refreshInFlight: Promise<boolean> | null = null;

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

async function performRefresh(): Promise<boolean> {
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

async function refreshAccessToken(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = performRefresh().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

export interface AuthSession {
  id: string;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
  session_started_at: string;
  last_active_at: string;
  expires_at: string;
  is_current: boolean;
}

export interface SecurityEvent {
  id: string;
  action: string;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
}

export interface MfaSetup {
  secret: string;
  otpauth_uri: string;
}

export interface AccountDeletionImpact {
  deletion_status: 'active' | 'pending' | 'purging' | 'failed' | 'deleted';
  can_delete: boolean;
  blockers: string[];
  personal_file_count: number;
  personal_storage_bytes: number;
  owned_projects: Array<{ id: string; slug: string; name: string }>;
  project_membership_count: number;
  active_shared_link_count: number;
  active_session_count: number;
  created_service_account_count: number;
  scheduled_for: string | null;
}

export interface AccountDeletionStatus {
  detail: string;
  status: string;
  scheduled_for: string | null;
}

/* ── Auth API ── */
export const authApi = {
  register: (data: { email: string; username: string; password: string }) =>
    request(`${AUTH_BASE}/auth/register`, { method: 'POST', body: JSON.stringify(data) }, false),

  login: (data: { email: string; password: string; otp_code?: string }) =>
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

  changePassword: (data: { current_password: string; new_password: string }) =>
    request<{ detail: string }>(`${AUTH_BASE}/auth/change-password`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  setupMfa: (currentPassword: string) =>
    request<MfaSetup>(`${AUTH_BASE}/auth/mfa/setup`, {
      method: 'POST', body: JSON.stringify({ current_password: currentPassword }),
    }),

  enableMfa: (code: string) =>
    request<{ detail: string; recovery_codes: string[] }>(`${AUTH_BASE}/auth/mfa/enable`, {
      method: 'POST', body: JSON.stringify({ code }),
    }),

  disableMfa: (currentPassword: string, code: string) =>
    request<{ detail: string }>(`${AUTH_BASE}/auth/mfa/disable`, {
      method: 'POST', body: JSON.stringify({ current_password: currentPassword, code }),
    }),

  listSessions: () => request<AuthSession[]>(`${AUTH_BASE}/auth/sessions`),

  listSecurityEvents: () => request<SecurityEvent[]>(`${AUTH_BASE}/auth/security-events`),

  revokeSession: (sessionId: string) =>
    request<{ detail: string }>(`${AUTH_BASE}/auth/sessions/${sessionId}`, { method: 'DELETE' }),

  revokeAllSessions: () =>
    request<{ detail: string }>(`${AUTH_BASE}/auth/sessions`, { method: 'DELETE' }),

  getDeletionImpact: () =>
    request<AccountDeletionImpact>(`${AUTH_BASE}/auth/account/deletion-impact`),

  requestDeletion: (data: { current_password: string; confirmation: string; mfa_code?: string }) =>
    request<AccountDeletionStatus>(`${AUTH_BASE}/auth/account/deletion-request`, {
      method: 'POST', body: JSON.stringify(data),
    }),

  cancelDeletion: (data: { email: string; current_password: string; mfa_code?: string }) =>
    request<AccountDeletionStatus>(`${AUTH_BASE}/auth/account/deletion-cancel`, {
      method: 'POST', body: JSON.stringify(data),
    }, false),
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

export interface ProjectOperationStatus {
  project_id: string;
  health_status: 'healthy' | 'warning' | 'critical' | 'unknown';
  metadata_bytes?: number;
  object_bytes?: number;
  usage_drift_bytes?: number;
  missing_objects?: number;
  orphan_objects?: number;
  stale_uploads?: number;
  expired_files?: number;
  details: Record<string, unknown>;
  checked_at: string | null;
}

export interface ProjectFileFilters {
  q?: string;
  artifact_type?: string;
  starred?: boolean;
  sort_by?: 'created_at' | 'updated_at' | 'name' | 'size' | 'artifact_type';
  sort_order?: 'asc' | 'desc';
  folder_id?: string;
}

export interface ProjectFile {
  id: string;
  project_id: string;
  folder_id: string | null;
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

export interface ProjectFolder {
  id: string;
  project_id: string;
  name: string;
  parent_id: string | null;
  path: string;
  depth: number;
  created_at: string;
  updated_at: string;
}

export interface AuditActivity {
  id: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  user_id: string | null;
  project_id: string | null;
  service_account_id: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
}

export interface AnalyticsStats {
  generated_at: string;
  scope: { personal: boolean; project_count: number };
  cards: {
    total_storage_bytes: number;
    active_files: number;
    starred_files: number;
    active_shares: number;
    trash_bytes: number;
  };
  file_types: { name: string; value: number; color: string }[];
  upload_activity: { time: string; uploads: number }[];
  storage_growth: { day: string; date: string; storage_bytes: number }[];
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

export interface ProjectMemberCandidate {
  id: string;
  username: string;
  email: string;
}

export interface ProjectUploadSession {
  session_id: string;
  project_id: string;
  status: 'PENDING' | 'AVAILABLE' | 'FAILED';
  original_name: string;
  mime_type: string;
  file_size: number;
  folder_id: string | null;
  part_size: number;
  part_count: number;
  expires_at: string;
  file?: ProjectFile;
  idempotent_replay?: boolean;
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

  getOperations: (projectId: string) =>
    request<ProjectOperationStatus>(`${FILE_BASE}/projects/${projectId}/operations`),

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
    folderId?: string | null,
    idempotencyKey = crypto.randomUUID(),
  ) => {
    const uploadOnce = () => new Promise<ProjectFile>((resolve, reject) => {
      const formData = new FormData();
      formData.append('file', file, file.name);
      formData.append('metadata_json', JSON.stringify(metadata));
      if (folderId) formData.append('folder_id', folderId);

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

  uploadMultipartWithProgress: async (
    projectId: string,
    file: File,
    metadata: Record<string, unknown>,
    onProgress: (percent: number) => void,
    signal?: AbortSignal,
    folderId?: string | null,
    idempotencyKey = crypto.randomUUID(),
  ) => {
    const session = await request<ProjectUploadSession>(
      `${FILE_BASE}/projects/${projectId}/upload-sessions`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({
          original_name: file.name,
          mime_type: file.type || 'application/octet-stream',
          file_size: file.size,
          folder_id: folderId || null,
          metadata,
        }),
        signal,
      },
    );
    if (session.file) return session.file;

    const loadedByPart = new Map<number, number>();
    const completedParts: { part_number: number; etag: string }[] = [];
    const updateProgress = (partNumber: number, loaded: number) => {
      loadedByPart.set(partNumber, loaded);
      const totalLoaded = [...loadedByPart.values()].reduce((sum, value) => sum + value, 0);
      onProgress(Math.min(99, Math.round((totalLoaded / file.size) * 100)));
    };
    const uploadPart = async (partNumber: number) => {
      if (signal?.aborted) throw new DOMException('Upload cancelled', 'AbortError');
      const { url } = await request<{ url: string }>(
        `${FILE_BASE}/projects/${projectId}/upload-sessions/${session.session_id}/parts/${partNumber}`,
        { signal },
      );
      const start = (partNumber - 1) * session.part_size;
      const chunk = file.slice(start, Math.min(start + session.part_size, file.size));
      const etag = await new Promise<string>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', url);
        xhr.upload.onprogress = (event) => updateProgress(partNumber, event.loaded);
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            const value = xhr.getResponseHeader('ETag');
            if (value) resolve(value.replaceAll('"', ''));
            else reject(new ApiError('Object storage did not return a part ETag', xhr.status));
          } else reject(new ApiError('Object storage rejected an upload part', xhr.status));
        };
        xhr.onerror = () => reject(new ApiError('Network error during multipart upload', 0));
        xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
        signal?.addEventListener('abort', () => xhr.abort(), { once: true });
        xhr.send(chunk);
      });
      updateProgress(partNumber, chunk.size);
      completedParts.push({ part_number: partNumber, etag });
    };

    try {
      let nextPart = 1;
      const workers = Array.from({ length: Math.min(3, session.part_count) }, async () => {
        while (nextPart <= session.part_count) {
          const partNumber = nextPart++;
          await uploadPart(partNumber);
        }
      });
      await Promise.all(workers);
      completedParts.sort((a, b) => a.part_number - b.part_number);
      const completed = await request<ProjectFile>(
        `${FILE_BASE}/projects/${projectId}/upload-sessions/${session.session_id}/complete`,
        { method: 'POST', body: JSON.stringify({ parts: completedParts }), signal },
      );
      onProgress(100);
      return completed;
    } catch (error) {
      await request<void>(
        `${FILE_BASE}/projects/${projectId}/upload-sessions/${session.session_id}`,
        { method: 'DELETE' },
      ).catch(() => undefined);
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

  listFolders: (projectId: string, parentId?: string | null) => {
    const suffix = parentId ? `?parent_id=${encodeURIComponent(parentId)}` : '';
    return request<{ folders: ProjectFolder[] }>(
      `${FILE_BASE}/projects/${projectId}/folders${suffix}`,
    );
  },

  createFolder: (projectId: string, name: string, parentId?: string | null) =>
    request<ProjectFolder>(`${FILE_BASE}/projects/${projectId}/folders`, {
      method: 'POST', body: JSON.stringify({ name, parent_id: parentId || null }),
    }),

  deleteFolder: (projectId: string, folderId: string) =>
    request<{ detail: string }>(`${FILE_BASE}/projects/${projectId}/folders/${folderId}`, {
      method: 'DELETE',
    }),

  moveFile: (projectId: string, fileId: string, folderId?: string | null) =>
    request<ProjectFile>(`${FILE_BASE}/projects/${projectId}/files/${fileId}/move`, {
      method: 'POST', body: JSON.stringify({ folder_id: folderId || null }),
    }),

  listMembers: (projectId: string) =>
    request<ProjectMember[]>(`${AUTH_BASE}/projects/${projectId}/members`),

  searchMemberCandidates: (projectId: string, query: string) =>
    request<ProjectMemberCandidate[]>(
      `${AUTH_BASE}/projects/${projectId}/member-candidates?q=${encodeURIComponent(query)}`,
    ),

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

  transferOwnership: (projectId: string, newOwnerUserId: string) =>
    request<Project>(`${AUTH_BASE}/projects/${projectId}/transfer-ownership`, {
      method: 'POST', body: JSON.stringify({ new_owner_user_id: newOwnerUserId }),
    }),

  listServiceAccounts: (projectId: string) =>
    request<ServiceAccount[]>(`${AUTH_BASE}/projects/${projectId}/service-accounts`),

  createServiceAccount: (projectId: string, data: { name: string; scopes: string[]; expires_at?: string }) =>
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

  getAnalytics: () => request<AnalyticsStats>(`${META_BASE}/analytics/stats`),

  search: (params: {
    q: string; page?: number; pageSize?: number; mimeType?: string;
    minSize?: number; maxSize?: number; dateFrom?: string; dateTo?: string;
    sortBy?: 'relevance' | 'created_at' | 'updated_at' | 'size' | 'original_name';
    sortOrder?: 'asc' | 'desc';
    projectId?: string;
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
    if (params.projectId) qs.set('project_id', params.projectId);
    return request(`${META_BASE}/search/?${qs.toString()}`);
  },

  suggest: (q: string) =>
    request(`${META_BASE}/search/suggest?q=${encodeURIComponent(q)}`),

  getActivity: (page = 1, pageSize = 20, projectId?: string) => {
    const query = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
    if (projectId) query.set('project_id', projectId);
    return request<{ activities: AuditActivity[]; total: number; page: number; page_size: number }>(
      `${META_BASE}/activity?${query.toString()}`,
    );
  },
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
