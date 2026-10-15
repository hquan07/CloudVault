'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  Activity, AlertCircle, Archive, ArchiveRestore, ArrowLeft, Check, Copy, Download, Eye, File,
  Folder, FolderPlus, HardDrive, Home, KeyRound, Loader2, RefreshCw, RotateCcw,
  Save, Search, Shield, Star, Trash2, UserPlus, X,
} from 'lucide-react';
import {
  ApiError, AuditActivity, Project, ProjectFile, ProjectFileFilters, ProjectFolder,
  ProjectMember, ProjectMemberCandidate, ProjectOperationStatus, ProjectUsage, ServiceAccount,
  metaApi, projectApi,
} from '@/lib/api';
import { formatBytes } from '@/lib/utils';
import { FilePreviewModal } from '@/components/FilePreviewModal';
import { ProjectUploadQueue } from '@/components/ProjectUploadQueue';
import { useAuth } from '@/lib/auth-context';

type Tab = 'files' | 'trash' | 'members' | 'integrations' | 'operations' | 'policy' | 'activity';

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const detail = error.data.detail;
    if (typeof detail === 'object' && detail && 'message' in detail) {
      return String((detail as { message: unknown }).message);
    }
    if (typeof detail === 'string') return detail;
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return 'Unable to complete the request.';
}

function formatDate(value: string | null): string {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Never';
}

function activityResourceName(activity: AuditActivity): string {
  const details = activity.details || {};
  return String(
    details.filename || details.folder_name || details.project_name || activity.resource_id || '',
  );
}

export default function ProjectDetailPage() {
  const { user } = useAuth();
  const params = useParams<{ projectId: string }>();
  const router = useRouter();
  const projectId = params.projectId;
  const [project, setProject] = useState<Project | null>(null);
  const [usage, setUsage] = useState<ProjectUsage | null>(null);
  const [operations, setOperations] = useState<ProjectOperationStatus | null>(null);
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [trash, setTrash] = useState<ProjectFile[]>([]);
  const [folders, setFolders] = useState<ProjectFolder[]>([]);
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [folderPath, setFolderPath] = useState<ProjectFolder[]>([]);
  const [previewFile, setPreviewFile] = useState<ProjectFile | null>(null);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [memberCandidates, setMemberCandidates] = useState<ProjectMemberCandidate[]>([]);
  const [memberQuery, setMemberQuery] = useState('');
  const [selectedCandidateId, setSelectedCandidateId] = useState('');
  const [memberSearchLoading, setMemberSearchLoading] = useState(false);
  const [accounts, setAccounts] = useState<ServiceAccount[]>([]);
  const [activities, setActivities] = useState<AuditActivity[]>([]);
  const [tab, setTab] = useState<Tab>('files');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [secret, setSecret] = useState<{ name: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [searchDraft, setSearchDraft] = useState('');
  const [artifactDraft, setArtifactDraft] = useState('');
  const [fileFilters, setFileFilters] = useState<ProjectFileFilters>({
    sort_by: 'created_at', sort_order: 'desc',
  });
  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(new Set());

  const loadData = useCallback(async () => {
    try {
      setError('');
      const [projectData, usageData, operationData, fileData, folderData, trashData, memberData, activityData] = await Promise.all([
        projectApi.get(projectId), projectApi.getUsage(projectId),
        projectApi.getOperations(projectId).catch(() => null),
        projectApi.listFiles(projectId, { ...fileFilters, folder_id: currentFolderId || 'root' }),
        projectApi.listFolders(projectId, currentFolderId), projectApi.listTrash(projectId),
        projectApi.listMembers(projectId),
        metaApi.getActivity(1, 100, projectId).catch(() => ({ activities: [], total: 0, page: 1, page_size: 100 })),
      ]);
      setProject(projectData);
      setUsage(usageData);
      setOperations(operationData);
      setFiles(fileData.files);
      setFolders(folderData.folders);
      setSelectedFileIds(new Set());
      setTrash(trashData.files);
      setMembers(memberData);
      setActivities(activityData.activities);
      if (projectData.member_role === 'admin') {
        setAccounts(await projectApi.listServiceAccounts(projectId));
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [currentFolderId, fileFilters, projectId]);

  useEffect(() => { void loadData(); }, [loadData]);

  const canWrite = project?.status === 'active'
    && (project.member_role === 'editor' || project.member_role === 'admin');
  const isAdmin = project?.member_role === 'admin';

  const archiveProject = async () => {
    if (!project || !window.confirm(
      `Archive ${project.name}? All service-account tokens will be revoked immediately.`,
    )) return;
    setLifecycleBusy(true);
    setError('');
    try {
      const updated = await projectApi.archive(projectId);
      setProject(updated);
      setAccounts((current) => current.map((account) => ({
        ...account, is_active: false, token_prefix: null, revoked_at: new Date().toISOString(),
      })));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLifecycleBusy(false);
    }
  };

  const restoreProject = async () => {
    setLifecycleBusy(true);
    setError('');
    try {
      setProject(await projectApi.restore(projectId));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLifecycleBusy(false);
    }
  };

  const deleteProject = async () => {
    if (!project || deleteConfirmation !== project.slug) return;
    setLifecycleBusy(true);
    setError('');
    try {
      await projectApi.delete(projectId, deleteConfirmation);
      router.replace('/dashboard/projects');
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
      setShowDelete(false);
      setDeleteConfirmation('');
    } finally {
      setLifecycleBusy(false);
    }
  };

  const downloadFile = async (item: ProjectFile) => {
    try {
      const blob = await projectApi.downloadFile(projectId, item.id);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = item.original_name;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) { setError(errorMessage(err)); }
  };

  const loadProjectPreview = useCallback(
    (item: { id: string }) => projectApi.downloadFile(projectId, item.id),
    [projectId],
  );

  const deleteFile = async (item: ProjectFile) => {
    if (!window.confirm(`Move ${item.original_name} to project trash?`)) return;
    try {
      await projectApi.deleteFile(projectId, item.id);
      setFiles((current) => current.filter((file) => file.id !== item.id));
      setSelectedFileIds((current) => {
        const next = new Set(current);
        next.delete(item.id);
        return next;
      });
      setTrash((current) => [{
        ...item,
        status: 'DELETED',
        is_deleted: true,
        deleted_at: new Date().toISOString(),
      }, ...current]);
    } catch (err) { setError(errorMessage(err)); }
  };

  const restoreFile = async (item: ProjectFile) => {
    try {
      const restored = await projectApi.restoreFile(projectId, item.id);
      setTrash((current) => current.filter((file) => file.id !== item.id));
      setFiles((current) => [restored, ...current]);
    } catch (err) { setError(errorMessage(err)); }
  };

  const permanentlyDeleteFile = async (item: ProjectFile) => {
    if (!window.confirm(`Permanently delete ${item.original_name}? This cannot be undone.`)) return;
    try {
      await projectApi.permanentlyDeleteFile(projectId, item.id);
      setTrash((current) => current.filter((file) => file.id !== item.id));
      await loadData();
    } catch (err) { setError(errorMessage(err)); }
  };

  const toggleFileStar = async (item: ProjectFile) => {
    try {
      if (item.is_starred) await projectApi.unstarFile(projectId, item.id);
      else await projectApi.starFile(projectId, item.id);
      if (fileFilters.starred !== undefined) await loadData();
      else {
        setFiles((current) => current.map((file) => (
          file.id === item.id ? { ...file, is_starred: !item.is_starred } : file
        )));
      }
    } catch (err) { setError(errorMessage(err)); }
  };

  const toggleFileSelection = (fileId: string) => {
    setSelectedFileIds((current) => {
      const next = new Set(current);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelectedFileIds((current) => (
      files.length > 0 && files.every((file) => current.has(file.id))
        ? new Set()
        : new Set(files.map((file) => file.id))
    ));
  };

  const bulkStarFiles = async (starred: boolean) => {
    const fileIds = [...selectedFileIds];
    if (!fileIds.length) return;
    try {
      await projectApi.bulkStarFiles(projectId, fileIds, starred);
      await loadData();
    } catch (err) { setError(errorMessage(err)); }
  };

  const bulkDeleteFiles = async () => {
    const fileIds = [...selectedFileIds];
    if (!fileIds.length || !window.confirm(`Move ${fileIds.length} selected files to project trash?`)) return;
    try {
      await projectApi.bulkDeleteFiles(projectId, fileIds);
      await loadData();
    } catch (err) { setError(errorMessage(err)); }
  };

  const applyFileSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFileFilters((current) => ({
      ...current,
      q: searchDraft.trim() || undefined,
      artifact_type: artifactDraft.trim() || undefined,
    }));
  };

  const openFolder = (folder: ProjectFolder) => {
    setFolderPath((current) => [...current, folder]);
    setCurrentFolderId(folder.id);
  };

  const openFolderLevel = (index: number) => {
    if (index < 0) {
      setFolderPath([]);
      setCurrentFolderId(null);
      return;
    }
    setFolderPath((current) => current.slice(0, index + 1));
    setCurrentFolderId(folderPath[index].id);
  };

  const createFolder = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      await projectApi.createFolder(projectId, String(form.get('name')), currentFolderId);
      formElement.reset();
      await loadData();
    } catch (err) { setError(errorMessage(err)); }
  };

  const deleteFolder = async (folder: ProjectFolder) => {
    if (!window.confirm(`Delete empty folder ${folder.name}?`)) return;
    try {
      await projectApi.deleteFolder(projectId, folder.id);
      setFolders((current) => current.filter((item) => item.id !== folder.id));
    } catch (err) { setError(errorMessage(err)); }
  };

  const moveFile = async (item: ProjectFile, destinationId: string) => {
    try {
      await projectApi.moveFile(projectId, item.id, destinationId || null);
      await loadData();
    } catch (err) { setError(errorMessage(err)); }
  };

  const refreshActivity = async () => {
    try {
      const data = await metaApi.getActivity(1, 100, projectId);
      setActivities(data.activities);
    } catch (err) { setError(errorMessage(err)); }
  };

  const refreshOperations = async () => {
    try {
      setOperations(await projectApi.getOperations(projectId));
      setUsage(await projectApi.getUsage(projectId));
    } catch (err) { setError(errorMessage(err)); }
  };

  const saveSettings = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSavingSettings(true);
    setSettingsSaved(false);
    setError('');
    try {
      const retentionPolicy = { ...(project?.retention_policy || {}) };
      for (const key of ['default_days', 'temporary_days', 'archive_days'] as const) {
        const raw = String(form.get(key) || '').trim();
        if (!raw) delete retentionPolicy[key];
        else {
          const days = Number(raw);
          if (!Number.isInteger(days) || days < 1) throw new Error('Retention days must be positive whole numbers.');
          retentionPolicy[key] = days;
        }
      }
      const mimeTypes = String(form.get('allowed_mime_types') || '')
        .split(',').map((value) => value.trim()).filter(Boolean);
      if (mimeTypes.length) retentionPolicy.allowed_mime_types = [...new Set(mimeTypes)];
      else delete retentionPolicy.allowed_mime_types;
      const updated = await projectApi.update(projectId, {
        name: String(form.get('name')),
        description: String(form.get('description') || ''),
        ...(project?.status !== 'archived' ? { status: String(form.get('status')) as 'active' | 'suspended' } : {}),
        storage_quota: Math.round(Number(form.get('quota_gb')) * 1024 ** 3),
        max_file_size: Math.round(Number(form.get('max_file_mb')) * 1024 ** 2),
        warning_percent: Number(form.get('warning_percent')),
        retention_policy: retentionPolicy,
      });
      setProject(updated);
      setUsage(await projectApi.getUsage(projectId));
      setSettingsSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSavingSettings(false);
    }
  };

  const addMember = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      const member = await projectApi.addMember(
        projectId, selectedCandidateId, String(form.get('role')) as ProjectMember['role'],
      );
      setMembers((current) => [...current, member].sort((a, b) => a.username.localeCompare(b.username)));
      formElement.reset();
      setMemberQuery('');
      setSelectedCandidateId('');
      setMemberCandidates([]);
    } catch (err) { setError(errorMessage(err)); }
  };

  const searchMemberCandidates = async () => {
    if (memberQuery.trim().length < 2) return;
    setMemberSearchLoading(true);
    setError('');
    try {
      const candidates = await projectApi.searchMemberCandidates(projectId, memberQuery.trim());
      setMemberCandidates(candidates);
      setSelectedCandidateId(candidates.length === 1 ? candidates[0].id : '');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setMemberSearchLoading(false);
    }
  };

  const changeMemberRole = async (member: ProjectMember, role: ProjectMember['role']) => {
    try {
      const updated = await projectApi.updateMember(projectId, member.id, role);
      setMembers((current) => current.map((item) => item.id === member.id ? updated : item));
    } catch (err) { setError(errorMessage(err)); }
  };

  const removeMember = async (member: ProjectMember) => {
    if (!window.confirm(`Remove ${member.username} from this project?`)) return;
    try {
      await projectApi.removeMember(projectId, member.id);
      setMembers((current) => current.filter((item) => item.id !== member.id));
    } catch (err) { setError(errorMessage(err)); }
  };

  const transferOwnership = async (member: ProjectMember) => {
    if (!project || !window.confirm(
      `Transfer ownership of ${project.name} to ${member.username}? Project data and service accounts will remain unchanged.`,
    )) return;
    setLifecycleBusy(true);
    setError('');
    try {
      setProject(await projectApi.transferOwnership(projectId, member.user_id));
      await refreshActivity();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLifecycleBusy(false);
    }
  };

  const createAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const scopes = form.getAll('scopes').map(String);
    try {
      const expiresAt = String(form.get('expires_at') || '');
      const account = await projectApi.createServiceAccount(projectId, {
        name: String(form.get('name')),
        scopes,
        ...(expiresAt ? { expires_at: new Date(`${expiresAt}T23:59:59`).toISOString() } : {}),
      });
      setAccounts((current) => [account, ...current]);
      setSecret({ name: account.name, token: account.token || '' });
      formElement.reset();
    } catch (err) { setError(errorMessage(err)); }
  };

  const rotateAccount = async (account: ServiceAccount) => {
    if (!window.confirm(`Rotate the token for ${account.name}? The old token will stop working immediately.`)) return;
    try {
      const updated = await projectApi.rotateServiceAccount(projectId, account.id);
      setAccounts((current) => current.map((item) => item.id === account.id ? updated : item));
      setSecret({ name: updated.name, token: updated.token || '' });
    } catch (err) { setError(errorMessage(err)); }
  };

  const revokeAccount = async (account: ServiceAccount) => {
    if (!window.confirm(`Revoke ${account.name}? This cannot be undone without rotating it.`)) return;
    try {
      await projectApi.revokeServiceAccount(projectId, account.id);
      setAccounts((current) => current.map((item) => item.id === account.id ? { ...item, is_active: false, token_prefix: null } : item));
    } catch (err) { setError(errorMessage(err)); }
  };

  if (loading) return <div className="flex h-full items-center justify-center"><Loader2 className="animate-spin text-cyan-400" size={34} /></div>;
  if (!project) return (
    <div className="mx-auto max-w-2xl rounded-2xl border border-red-500/20 bg-red-500/10 p-8 text-center text-red-200">
      <AlertCircle className="mx-auto mb-3" /><p>{error || 'Project not found or access denied.'}</p>
      <Link href="/dashboard/projects" className="mt-5 inline-block text-cyan-300">Back to projects</Link>
    </div>
  );

  const usagePercent = Math.min(100, usage?.percentage || 0);
  const retentionPolicy = project.retention_policy || {};
  const allowedMimeTypes = Array.isArray(retentionPolicy.allowed_mime_types)
    ? retentionPolicy.allowed_mime_types.map(String)
    : [];
  const publicApiBase = typeof window === 'undefined' ? '' : window.location.origin;
  const tabs: { id: Tab; label: string }[] = [
    { id: 'files', label: 'Files' }, { id: 'trash', label: `Trash${trash.length ? ` (${trash.length})` : ''}` },
    { id: 'members', label: 'Members' }, { id: 'activity', label: 'Activity' },
    { id: 'operations', label: 'Operations' }, { id: 'policy', label: 'Settings' },
    ...(isAdmin ? [{ id: 'integrations' as Tab, label: 'Integrations' }] : []),
  ];

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <Link href="/dashboard/projects" className="inline-flex items-center gap-2 text-sm text-gray-400 hover:text-cyan-300"><ArrowLeft size={16} /> Projects</Link>
      <div className="rounded-2xl border border-gray-800 bg-gray-900 p-6">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-3xl font-bold text-white">{project.name}</h1>
              <span className="rounded-full bg-cyan-500/10 px-3 py-1 text-xs capitalize text-cyan-300">{project.member_role}</span>
              <span className="rounded-full border border-gray-700 px-3 py-1 text-xs capitalize text-gray-300">{project.status}</span>
            </div>
            <p className="mt-2 font-mono text-xs text-gray-500">{project.slug}</p>
            <p className="mt-3 max-w-2xl text-sm text-gray-400">{project.description || 'No description provided.'}</p>
          </div>
          <div className="w-full max-w-md space-y-3">
            <div className="rounded-xl border border-gray-800 bg-gray-950/60 p-4">
              <div className="mb-2 flex justify-between text-sm"><span className="inline-flex items-center gap-2 text-gray-300"><HardDrive size={16} /> Project storage</span><span className="text-gray-400">{usagePercent.toFixed(1)}%</span></div>
              <div className="h-2.5 overflow-hidden rounded-full bg-gray-800"><div className={`h-full ${usagePercent >= project.warning_percent ? 'bg-amber-500' : 'bg-cyan-500'}`} style={{ width: `${usagePercent}%` }} /></div>
              <div className="mt-2 flex justify-between text-xs text-gray-500"><span>{formatBytes(usage?.storage_used || 0)} used</span><span>{formatBytes(usage?.storage_quota || 0)} total</span></div>
            </div>
            {isAdmin && (
              <div className="flex flex-wrap justify-end gap-2">
                {project.status === 'archived' ? (
                  <>
                    <button disabled={lifecycleBusy} onClick={() => void restoreProject()} className="inline-flex items-center gap-2 rounded-lg border border-emerald-500/30 px-3 py-2 text-sm text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-50"><ArchiveRestore size={16} /> Restore</button>
                    <button disabled={lifecycleBusy} onClick={() => setShowDelete(true)} className="inline-flex items-center gap-2 rounded-lg border border-red-500/30 px-3 py-2 text-sm text-red-300 hover:bg-red-500/10 disabled:opacity-50"><Trash2 size={16} /> Delete permanently</button>
                  </>
                ) : (
                  <button disabled={lifecycleBusy} onClick={() => void archiveProject()} className="inline-flex items-center gap-2 rounded-lg border border-amber-500/30 px-3 py-2 text-sm text-amber-300 hover:bg-amber-500/10 disabled:opacity-50"><Archive size={16} /> Archive project</button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {project.status === 'archived' && (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-amber-200">
          This project is read-only. Its service-account tokens were revoked when it was archived and must be rotated after restoration.
        </div>
      )}

      {error && <div className="flex items-center justify-between rounded-xl border border-red-500/20 bg-red-500/10 p-4 text-red-300"><span className="flex items-center gap-3"><AlertCircle size={18} />{error}</span><button onClick={() => setError('')}><X size={17} /></button></div>}

      {operations && operations.health_status !== 'unknown' && operations.health_status !== 'healthy' && (
        <div className={`rounded-xl border p-4 ${
          operations.health_status === 'critical'
            ? 'border-red-500/30 bg-red-500/10 text-red-200'
            : operations.health_status === 'warning'
              ? 'border-amber-500/30 bg-amber-500/10 text-amber-200'
              : 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200'
        }`}>
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <span className="inline-flex items-center gap-2 font-medium">
              <Shield size={18} /> Operational health: {operations.health_status}
            </span>
            <span className="text-xs opacity-70">Checked {formatDate(operations.checked_at)}</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs opacity-90">
            <span>Missing objects: {operations.missing_objects || 0}</span>
            <span>Orphan objects: {operations.orphan_objects || 0}</span>
            <span>Stale uploads: {operations.stale_uploads || 0}</span>
            <span>Expired files: {operations.expired_files || 0}</span>
            <span>Usage drift: {formatBytes(Math.abs(operations.usage_drift_bytes || 0))}</span>
          </div>
        </div>
      )}

      <div className="flex gap-2 overflow-x-auto border-b border-gray-800">
        {tabs.map((item) => <button key={item.id} onClick={() => setTab(item.id)} className={`whitespace-nowrap border-b-2 px-4 py-3 text-sm ${tab === item.id ? 'border-cyan-400 text-cyan-300' : 'border-transparent text-gray-400 hover:text-white'}`}>{item.label}</button>)}
      </div>

      {tab === 'files' && (
        <section className="space-y-5">
          <div className="flex flex-col gap-3 rounded-2xl border border-gray-800 bg-gray-900 p-4 md:flex-row md:items-center md:justify-between">
            <nav className="flex flex-wrap items-center gap-1 text-sm">
              <button onClick={() => openFolderLevel(-1)} className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-gray-400 hover:bg-gray-800 hover:text-cyan-300"><Home size={15} /> Root</button>
              {folderPath.map((folder, index) => <span key={folder.id} className="inline-flex items-center"><span className="text-gray-700">/</span><button onClick={() => openFolderLevel(index)} className="rounded-lg px-2 py-1.5 text-gray-400 hover:bg-gray-800 hover:text-cyan-300">{folder.name}</button></span>)}
            </nav>
            {canWrite && <form onSubmit={createFolder} className="flex gap-2"><input required name="name" maxLength={255} placeholder="New folder" className="min-w-0 rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-white" /><button className="inline-flex items-center gap-2 rounded-lg border border-cyan-500/30 px-3 py-2 text-sm text-cyan-300 hover:bg-cyan-500/10"><FolderPlus size={16} /> Create</button></form>}
          </div>

          {folders.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {folders.map((folder) => <div key={folder.id} className="group flex items-center justify-between rounded-xl border border-gray-800 bg-gray-900 p-3 hover:border-cyan-500/30"><button onClick={() => openFolder(folder)} className="flex min-w-0 flex-1 items-center gap-3 text-left"><span className="rounded-lg bg-cyan-500/10 p-2 text-cyan-400"><Folder size={18} /></span><span className="truncate text-sm font-medium text-gray-200">{folder.name}</span></button>{canWrite && <button onClick={() => void deleteFolder(folder)} title="Delete empty folder" className="rounded-lg p-2 text-gray-600 opacity-0 hover:bg-red-500/10 hover:text-red-300 group-hover:opacity-100"><Trash2 size={15} /></button>}</div>)}
            </div>
          )}

          <form onSubmit={applyFileSearch} className="grid gap-3 rounded-2xl border border-gray-800 bg-gray-900 p-4 lg:grid-cols-[minmax(220px,1fr)_180px_150px_160px_120px_auto] lg:items-end">
            <label className="text-sm text-gray-300">Search<input value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} placeholder="File name" className="mt-1.5 w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-white" /></label>
            <label className="text-sm text-gray-300">Artifact type<input value={artifactDraft} onChange={(event) => setArtifactDraft(event.target.value)} placeholder="report" className="mt-1.5 w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-white" /></label>
            <label className="text-sm text-gray-300">Star<select value={fileFilters.starred === undefined ? '' : String(fileFilters.starred)} onChange={(event) => setFileFilters((current) => ({ ...current, starred: event.target.value === '' ? undefined : event.target.value === 'true' }))} className="mt-1.5 w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-white"><option value="">All</option><option value="true">Starred</option><option value="false">Not starred</option></select></label>
            <label className="text-sm text-gray-300">Sort by<select value={fileFilters.sort_by} onChange={(event) => setFileFilters((current) => ({ ...current, sort_by: event.target.value as ProjectFileFilters['sort_by'] }))} className="mt-1.5 w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-white"><option value="created_at">Uploaded</option><option value="updated_at">Updated</option><option value="name">Name</option><option value="size">Size</option><option value="artifact_type">Artifact</option></select></label>
            <label className="text-sm text-gray-300">Order<select value={fileFilters.sort_order} onChange={(event) => setFileFilters((current) => ({ ...current, sort_order: event.target.value as ProjectFileFilters['sort_order'] }))} className="mt-1.5 w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-white"><option value="desc">Descending</option><option value="asc">Ascending</option></select></label>
            <div className="flex gap-2"><button className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-cyan-500 px-3 py-2 font-medium text-gray-950"><Search size={16} /> Apply</button><button type="button" onClick={() => { setSearchDraft(''); setArtifactDraft(''); setFileFilters({ sort_by: 'created_at', sort_order: 'desc' }); }} title="Clear filters" className="rounded-lg border border-gray-700 p-2 text-gray-400 hover:text-white"><X size={17} /></button></div>
          </form>

          {selectedFileIds.size > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-cyan-500/20 bg-cyan-500/10 p-3">
              <span className="text-sm text-cyan-200">{selectedFileIds.size} selected</span>
              <div className="flex flex-wrap gap-2">
                <button onClick={() => void bulkStarFiles(true)} className="inline-flex items-center gap-2 rounded-lg border border-yellow-500/30 px-3 py-2 text-sm text-yellow-300 hover:bg-yellow-500/10"><Star size={15} /> Star</button>
                <button onClick={() => void bulkStarFiles(false)} className="inline-flex items-center gap-2 rounded-lg border border-gray-700 px-3 py-2 text-sm text-gray-300 hover:bg-gray-800"><Star size={15} /> Unstar</button>
                {canWrite && <button onClick={() => void bulkDeleteFiles()} className="inline-flex items-center gap-2 rounded-lg border border-red-500/30 px-3 py-2 text-sm text-red-300 hover:bg-red-500/10"><Trash2 size={15} /> Move to trash</button>}
              </div>
            </div>
          )}

          {canWrite && (
            <ProjectUploadQueue
              projectId={projectId}
              currentFolderId={currentFolderId}
              onComplete={loadData}
            />
          )}
          {files.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-gray-700 p-14 text-center text-gray-400"><File className="mx-auto mb-3 text-gray-600" size={42} /><p>No files in this project.</p>{!canWrite && <p className="mt-1 text-xs">Your viewer role is read-only.</p>}</div>
          ) : (
            <div className="overflow-hidden rounded-2xl border border-gray-800 bg-gray-900">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-gray-800 text-xs uppercase text-gray-500">
                    <tr>
                      <th className="p-4"><label className="flex items-center gap-3"><input type="checkbox" checked={files.length > 0 && files.every((file) => selectedFileIds.has(file.id))} onChange={toggleSelectAll} className="accent-cyan-500" /> File</label></th>
                      <th className="p-4">Artifact</th><th className="p-4">Size</th><th className="p-4">Uploaded</th><th className="p-4 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800">
                    {files.map((item) => (
                      <tr key={item.id} className="hover:bg-gray-800/40">
                        <td className="p-4"><div className="flex items-start gap-3"><input type="checkbox" checked={selectedFileIds.has(item.id)} onChange={() => toggleFileSelection(item.id)} className="mt-1 accent-cyan-500" /><div><button onClick={() => setPreviewFile(item)} className="font-medium text-gray-100 hover:text-cyan-300">{item.original_name}</button><div className="mt-1 font-mono text-[11px] text-gray-600">{item.checksum_sha256.slice(0, 16)}…</div></div></div></td>
                        <td className="p-4 text-gray-400">{String(item.metadata.artifact_type || '—')}</td>
                        <td className="p-4 text-gray-400">{formatBytes(item.size)}</td>
                        <td className="p-4 text-gray-400">{formatDate(item.created_at)}</td>
                        <td className="p-4"><div className="flex justify-end gap-1">{canWrite && <select value="current" onChange={(event) => { if (event.target.value !== 'current') void moveFile(item, event.target.value); }} title="Move file" className="max-w-28 rounded-lg border border-gray-700 bg-gray-950 px-2 text-xs text-gray-400"><option value="current" disabled>Move…</option><option value="">Root</option>{folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select>}<button onClick={() => void toggleFileStar(item)} title={item.is_starred ? 'Remove star' : 'Add star'} className={`rounded-lg p-2 hover:bg-yellow-500/10 hover:text-yellow-300 ${item.is_starred ? 'text-yellow-400' : 'text-gray-400'}`}><Star size={17} className={item.is_starred ? 'fill-current' : ''} /></button><button onClick={() => setPreviewFile(item)} title="Preview" className="rounded-lg p-2 text-gray-400 hover:bg-cyan-500/10 hover:text-cyan-300"><Eye size={17} /></button><button onClick={() => void downloadFile(item)} title="Download" className="rounded-lg p-2 text-gray-400 hover:bg-cyan-500/10 hover:text-cyan-300"><Download size={17} /></button>{canWrite && <button onClick={() => void deleteFile(item)} title="Move to trash" className="rounded-lg p-2 text-gray-400 hover:bg-red-500/10 hover:text-red-300"><Trash2 size={17} /></button>}</div></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      )}

      {tab === 'trash' && (
        <section className="space-y-5">
          <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-amber-200">
            Trashed files still count toward the project quota. Permanent deletion removes the stored object and releases its space.
          </div>
          {trash.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-gray-700 p-14 text-center text-gray-400">
              <Trash2 className="mx-auto mb-3 text-gray-600" size={42} />
              <p>Project trash is empty.</p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-2xl border border-gray-800 bg-gray-900">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-gray-800 text-xs uppercase text-gray-500">
                    <tr><th className="p-4">File</th><th className="p-4">Size</th><th className="p-4">Deleted</th><th className="p-4 text-right">Actions</th></tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800">
                    {trash.map((item) => (
                      <tr key={item.id} className="hover:bg-gray-800/40">
                        <td className="p-4"><div className="font-medium text-gray-100">{item.original_name}</div><div className="mt-1 text-xs text-gray-600">{String(item.metadata.artifact_type || '—')}</div></td>
                        <td className="p-4 text-gray-400">{formatBytes(item.size)}</td>
                        <td className="p-4 text-gray-400">{formatDate(item.deleted_at)}</td>
                        <td className="p-4"><div className="flex justify-end gap-1">
                          {canWrite && <button onClick={() => void restoreFile(item)} title="Restore" className="rounded-lg p-2 text-gray-400 hover:bg-emerald-500/10 hover:text-emerald-300"><RotateCcw size={17} /></button>}
                          {isAdmin && <button onClick={() => void permanentlyDeleteFile(item)} title="Delete permanently" className="rounded-lg p-2 text-gray-400 hover:bg-red-500/10 hover:text-red-300"><Trash2 size={17} /></button>}
                        </div></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      )}

      {tab === 'members' && (
        <section className="space-y-5">
          {isAdmin && <form onSubmit={addMember} className="space-y-4 rounded-2xl border border-gray-800 bg-gray-900 p-5">
            <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
              <label className="text-sm text-gray-300">Find user by email or username<input value={memberQuery} onChange={(event) => { setMemberQuery(event.target.value); setSelectedCandidateId(''); }} minLength={2} placeholder="name@example.com or username" className="mt-1.5 w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-white" /></label>
              <button type="button" disabled={memberSearchLoading || memberQuery.trim().length < 2} onClick={() => void searchMemberCandidates()} className="inline-flex items-center justify-center gap-2 rounded-lg border border-cyan-500/30 px-4 py-2 text-cyan-300 disabled:opacity-40">{memberSearchLoading ? <Loader2 className="animate-spin" size={17} /> : <Search size={17} />} Search</button>
            </div>
            {memberCandidates.length > 0 && <div className="grid gap-2 sm:grid-cols-2">{memberCandidates.map((candidate) => <label key={candidate.id} className={`cursor-pointer rounded-xl border p-3 ${selectedCandidateId === candidate.id ? 'border-cyan-500/60 bg-cyan-500/10' : 'border-gray-800 bg-gray-950/60'}`}><input type="radio" name="candidate" value={candidate.id} checked={selectedCandidateId === candidate.id} onChange={() => setSelectedCandidateId(candidate.id)} className="mr-3 accent-cyan-500" /><span className="font-medium text-gray-200">{candidate.username}</span><span className="ml-2 text-sm text-gray-500">{candidate.email}</span></label>)}</div>}
            {memberCandidates.length === 0 && memberQuery.trim().length >= 2 && !memberSearchLoading && <p className="text-sm text-gray-500">Search to find active users who are not already members.</p>}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-end"><label className="text-sm text-gray-300">Role<select name="role" className="mt-1.5 w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-white"><option value="viewer">Viewer</option><option value="editor">Editor</option><option value="admin">Admin</option></select></label><button disabled={!selectedCandidateId} className="inline-flex items-center justify-center gap-2 rounded-lg bg-cyan-500 px-4 py-2 font-medium text-gray-950 disabled:opacity-40"><UserPlus size={17} /> Add member</button></div>
          </form>}
          <div className="overflow-hidden rounded-2xl border border-gray-800 bg-gray-900"><div className="divide-y divide-gray-800">{members.map((member) => <div key={member.id} className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between"><div className="flex items-center gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-full bg-gray-800 font-semibold text-gray-300">{member.username.charAt(0).toUpperCase()}</div><div><div className="flex items-center gap-2 font-medium text-white">{member.username}{project?.created_by === member.user_id && <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-300">Owner</span>}</div><div className="text-sm text-gray-500">{member.email}</div></div></div><div className="flex flex-wrap items-center gap-2">{isAdmin ? <select value={member.role} onChange={(event) => void changeMemberRole(member, event.target.value as ProjectMember['role'])} className="rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm capitalize text-white"><option value="viewer">Viewer</option><option value="editor">Editor</option><option value="admin">Admin</option></select> : <span className="rounded-full border border-gray-700 px-3 py-1 text-xs capitalize text-gray-300">{member.role}</span>}{isAdmin && member.role === 'admin' && project?.created_by !== member.user_id && (project?.created_by === user?.id || user?.role === 'admin') && <button disabled={lifecycleBusy} onClick={() => void transferOwnership(member)} className="inline-flex items-center gap-2 rounded-lg border border-amber-500/25 px-3 py-2 text-xs text-amber-300 hover:bg-amber-500/10 disabled:opacity-40"><Shield size={15} /> Transfer ownership</button>}{isAdmin && <button onClick={() => void removeMember(member)} className="rounded-lg p-2 text-gray-500 hover:bg-red-500/10 hover:text-red-300"><Trash2 size={17} /></button>}</div></div>)}</div></div>
        </section>
      )}

      {tab === 'activity' && (
        <section className="space-y-4">
          <div className="flex items-center justify-between"><div><h2 className="font-semibold text-white">Project activity</h2><p className="mt-1 text-sm text-gray-500">Lifecycle, storage and organization events across users and service accounts.</p></div><button onClick={() => void refreshActivity()} className="inline-flex items-center gap-2 rounded-lg border border-gray-700 px-3 py-2 text-sm text-gray-300 hover:border-cyan-500/40 hover:text-cyan-300"><RefreshCw size={15} /> Refresh</button></div>
          {activities.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-gray-700 p-14 text-center text-gray-400"><Activity className="mx-auto mb-3 text-gray-600" size={42} /><p>No project activity has been recorded yet.</p></div>
          ) : (
            <div className="overflow-hidden rounded-2xl border border-gray-800 bg-gray-900">
              <div className="divide-y divide-gray-800">
                {activities.map((activity) => <div key={activity.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"><div className="flex min-w-0 items-center gap-3"><span className="rounded-lg bg-gray-800 p-2 text-cyan-400"><Activity size={17} /></span><div className="min-w-0"><div className="text-sm font-medium text-gray-200">{activity.action.replaceAll('_', ' ')}</div><div className="truncate text-xs text-gray-500">{activity.resource_type}{activityResourceName(activity) ? ` · ${activityResourceName(activity)}` : ''}{activity.service_account_id ? ' · service account' : activity.user_id ? ' · user' : ''}</div></div></div><time className="shrink-0 text-xs text-gray-500">{formatDate(activity.created_at)}</time></div>)}
              </div>
            </div>
          )}
        </section>
      )}

      {tab === 'operations' && (
        <section className="space-y-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="font-semibold text-white">Storage operations</h2><p className="mt-1 text-sm text-gray-500">Latest reconciliation between metadata, quota accounting and object storage.</p></div><button onClick={() => void refreshOperations()} className="inline-flex items-center justify-center gap-2 rounded-lg border border-gray-700 px-3 py-2 text-sm text-gray-300 hover:border-cyan-500/40 hover:text-cyan-300"><RefreshCw size={15} /> Refresh</button></div>
          <div className={`rounded-2xl border p-5 ${operations?.health_status === 'critical' ? 'border-red-500/30 bg-red-500/10' : operations?.health_status === 'warning' ? 'border-amber-500/30 bg-amber-500/10' : 'border-emerald-500/20 bg-emerald-500/10'}`}><div className="flex items-center justify-between gap-3"><span className="inline-flex items-center gap-2 font-medium capitalize text-white"><Shield size={18} /> {operations?.health_status || 'unknown'}</span><span className="text-xs text-gray-400">Checked {formatDate(operations?.checked_at || null)}</span></div></div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-2xl border border-gray-800 bg-gray-900 p-5"><div className="text-sm text-gray-500">Metadata bytes</div><div className="mt-2 text-xl font-semibold text-white">{formatBytes(operations?.metadata_bytes || 0)}</div></div>
            <div className="rounded-2xl border border-gray-800 bg-gray-900 p-5"><div className="text-sm text-gray-500">Object bytes</div><div className="mt-2 text-xl font-semibold text-white">{formatBytes(operations?.object_bytes || 0)}</div></div>
            <div className="rounded-2xl border border-gray-800 bg-gray-900 p-5"><div className="text-sm text-gray-500">Usage drift</div><div className="mt-2 text-xl font-semibold text-white">{formatBytes(Math.abs(operations?.usage_drift_bytes || 0))}</div></div>
            <div className="rounded-2xl border border-gray-800 bg-gray-900 p-5"><div className="text-sm text-gray-500">Available</div><div className="mt-2 text-xl font-semibold text-white">{formatBytes(usage?.available_bytes || 0)}</div></div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[['Missing objects', operations?.missing_objects || 0], ['Orphan objects', operations?.orphan_objects || 0], ['Stale uploads', operations?.stale_uploads || 0], ['Expired files', operations?.expired_files || 0]].map(([label, value]) => <div key={String(label)} className="rounded-xl border border-gray-800 bg-gray-900 p-4"><div className="text-sm text-gray-500">{label}</div><div className={`mt-2 text-2xl font-semibold ${Number(value) ? 'text-amber-300' : 'text-emerald-300'}`}>{value}</div></div>)}
          </div>
          {!operations && <div className="rounded-xl border border-dashed border-gray-700 p-10 text-center text-gray-500">No reconciliation result is available yet.</div>}
        </section>
      )}

      {tab === 'policy' && (
        <section className="space-y-5">
          <div className="grid gap-5 md:grid-cols-3">
            <div className="rounded-2xl border border-gray-800 bg-gray-900 p-5"><div className="text-sm text-gray-500">Maximum file size</div><div className="mt-2 text-xl font-semibold text-white">{formatBytes(project.max_file_size)}</div></div>
            <div className="rounded-2xl border border-gray-800 bg-gray-900 p-5"><div className="text-sm text-gray-500">Quota warning</div><div className="mt-2 text-xl font-semibold text-white">{project.warning_percent}%</div></div>
            <div className="rounded-2xl border border-gray-800 bg-gray-900 p-5"><div className="text-sm text-gray-500">Available storage</div><div className="mt-2 text-xl font-semibold text-white">{formatBytes(usage?.available_bytes || 0)}</div></div>
          </div>
          {isAdmin ? (
            <form key={project.updated_at} onSubmit={saveSettings} className="space-y-5 rounded-2xl border border-gray-800 bg-gray-900 p-6">
              <div><h2 className="text-lg font-semibold text-white">Project settings</h2><p className="mt-1 text-sm text-gray-500">Changes apply to both browser users and connected applications.</p></div>
              <div className="grid gap-4 md:grid-cols-2">
                <label className="text-sm text-gray-300">Name<input required name="name" minLength={2} maxLength={120} defaultValue={project.name} className="mt-1.5 w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2.5 text-white" /></label>
                <label className="text-sm text-gray-300">Status<select name="status" defaultValue={project.status === 'archived' ? 'archived' : project.status} disabled={project.status === 'archived'} className="mt-1.5 w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2.5 capitalize text-white disabled:opacity-60"><option value="active">Active</option><option value="suspended">Suspended</option>{project.status === 'archived' && <option value="archived">Archived</option>}</select></label>
                <label className="text-sm text-gray-300 md:col-span-2">Description<textarea name="description" maxLength={1000} rows={3} defaultValue={project.description || ''} className="mt-1.5 w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2.5 text-white" /></label>
                <label className="text-sm text-gray-300">Quota (GB)<input required name="quota_gb" type="number" min="0" step="0.01" defaultValue={Number((project.storage_quota / 1024 ** 3).toFixed(4))} className="mt-1.5 w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2.5 text-white" /></label>
                <label className="text-sm text-gray-300">Maximum file size (MB)<input required name="max_file_mb" type="number" min="1" step="1" defaultValue={Number((project.max_file_size / 1024 ** 2).toFixed(2))} className="mt-1.5 w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2.5 text-white" /></label>
                <label className="text-sm text-gray-300">Warning threshold (%)<input required name="warning_percent" type="number" min="1" max="100" defaultValue={project.warning_percent} className="mt-1.5 w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2.5 text-white" /></label>
                <fieldset className="space-y-4 rounded-xl border border-gray-800 p-4 md:col-span-2">
                  <legend className="px-2 text-sm font-medium text-gray-200">Retention policy</legend>
                  <div className="grid gap-4 sm:grid-cols-3">
                    <label className="text-sm text-gray-300">Default (days)<input name="default_days" type="number" min="1" step="1" defaultValue={typeof retentionPolicy.default_days === 'number' ? retentionPolicy.default_days : ''} placeholder="No expiry" className="mt-1.5 w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2.5 text-white" /></label>
                    <label className="text-sm text-gray-300">Temporary (days)<input name="temporary_days" type="number" min="1" step="1" defaultValue={typeof retentionPolicy.temporary_days === 'number' ? retentionPolicy.temporary_days : ''} placeholder="No expiry" className="mt-1.5 w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2.5 text-white" /></label>
                    <label className="text-sm text-gray-300">Archive (days)<input name="archive_days" type="number" min="1" step="1" defaultValue={typeof retentionPolicy.archive_days === 'number' ? retentionPolicy.archive_days : ''} placeholder="No expiry" className="mt-1.5 w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2.5 text-white" /></label>
                  </div>
                  <label className="text-sm text-gray-300">Allowed MIME types<input name="allowed_mime_types" defaultValue={allowedMimeTypes.join(', ')} placeholder="application/pdf, text/csv (empty allows all)" className="mt-1.5 w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2.5 text-white" /><span className="mt-1 block text-xs text-gray-500">Comma-separated. Leave empty to accept every MIME type.</span></label>
                </fieldset>
              </div>
              {project.status === 'archived' && <p className="text-sm text-amber-300">Use Restore project before changing its lifecycle status. Other policy fields can still be updated.</p>}
              <div className="flex items-center justify-end gap-3">
                {settingsSaved && <span className="inline-flex items-center gap-2 text-sm text-emerald-300"><Check size={16} /> Saved</span>}
                <button disabled={savingSettings} className="inline-flex items-center gap-2 rounded-lg bg-cyan-500 px-4 py-2 font-medium text-gray-950 disabled:opacity-50">{savingSettings ? <Loader2 className="animate-spin" size={17} /> : <Save size={17} />} Save settings</button>
              </div>
            </form>
          ) : (
            <div className="rounded-2xl border border-gray-800 bg-gray-900 p-5"><h2 className="font-medium text-white">Retention policy</h2><div className="mt-4 grid gap-3 sm:grid-cols-3"><div className="rounded-xl bg-gray-950 p-3"><div className="text-xs text-gray-500">Default</div><div className="mt-1 text-gray-200">{typeof retentionPolicy.default_days === 'number' ? `${retentionPolicy.default_days} days` : 'No expiry'}</div></div><div className="rounded-xl bg-gray-950 p-3"><div className="text-xs text-gray-500">Temporary</div><div className="mt-1 text-gray-200">{typeof retentionPolicy.temporary_days === 'number' ? `${retentionPolicy.temporary_days} days` : 'Uses default'}</div></div><div className="rounded-xl bg-gray-950 p-3"><div className="text-xs text-gray-500">Archive</div><div className="mt-1 text-gray-200">{typeof retentionPolicy.archive_days === 'number' ? `${retentionPolicy.archive_days} days` : 'Uses default'}</div></div></div><div className="mt-3 text-sm text-gray-400">Allowed MIME types: {allowedMimeTypes.length ? allowedMimeTypes.join(', ') : 'All'}</div></div>
          )}
        </section>
      )}

      {tab === 'integrations' && isAdmin && (
        <section className="space-y-5">
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-2xl border border-gray-800 bg-gray-900 p-5"><h2 className="font-semibold text-white">Connection details</h2><dl className="mt-4 space-y-3 text-sm"><div><dt className="text-gray-500">Project ID / slug</dt><dd className="mt-1 font-mono text-cyan-200">{project.slug}</dd></div><div><dt className="text-gray-500">Upload endpoint</dt><dd className="mt-1 break-all font-mono text-gray-300">{publicApiBase}/api/v1/projects/{project.slug}/files/upload</dd></div><div><dt className="text-gray-500">Authentication</dt><dd className="mt-1 text-gray-300">Bearer service-account token</dd></div></dl></div>
            <div className="rounded-2xl border border-gray-800 bg-gray-900 p-5"><h2 className="font-semibold text-white">Application environment</h2><pre className="mt-4 overflow-x-auto rounded-xl bg-gray-950 p-4 text-xs text-gray-300">{`CLOUDVAULT_URL=${publicApiBase || 'http://localhost'}\nCLOUDVAULT_PROJECT_ID=${project.slug}\nCLOUDVAULT_TOKEN=<service-account-token>`}</pre><p className="mt-3 text-xs text-gray-500">Keep the token in a secret store. Never commit it to the connected project.</p></div>
          </div>
          <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-amber-200"><Shield className="mr-2 inline" size={17} />Tokens grant machine access only to this project. A raw token is shown once after creation or rotation.</div>
          {project.status === 'active' && <form onSubmit={createAccount} className="rounded-2xl border border-gray-800 bg-gray-900 p-5"><div className="grid gap-4 lg:grid-cols-[1fr_180px_2fr_auto] lg:items-end"><label className="text-sm text-gray-300">Account name<input required name="name" minLength={2} placeholder="news-flow-worker" className="mt-1.5 w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-white" /></label><label className="text-sm text-gray-300">Expires (optional)<input name="expires_at" type="date" min={new Date().toISOString().slice(0, 10)} className="mt-1.5 w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-white" /></label><fieldset><legend className="mb-2 text-sm text-gray-300">Scopes</legend><div className="flex flex-wrap gap-3">{['files:create', 'files:read', 'files:delete', 'project:usage:read'].map((scope) => <label key={scope} className="flex items-center gap-2 text-xs text-gray-400"><input type="checkbox" name="scopes" value={scope} defaultChecked={scope !== 'files:delete'} className="accent-cyan-500" />{scope}</label>)}</div></fieldset><button className="inline-flex items-center justify-center gap-2 rounded-lg bg-cyan-500 px-4 py-2 font-medium text-gray-950"><KeyRound size={17} /> Create token</button></div></form>}
          <div className="overflow-hidden rounded-2xl border border-gray-800 bg-gray-900"><div className="divide-y divide-gray-800">{accounts.length === 0 ? <div className="p-10 text-center text-gray-500">No service accounts.</div> : accounts.map((account) => <div key={account.id} className="flex flex-col gap-4 p-5 lg:flex-row lg:items-center lg:justify-between"><div><div className="flex items-center gap-2"><span className="font-medium text-white">{account.name}</span><span className={`rounded-full px-2 py-0.5 text-[11px] ${account.is_active ? 'bg-emerald-500/10 text-emerald-300' : 'bg-red-500/10 text-red-300'}`}>{account.is_active ? 'active' : 'revoked'}</span></div><div className="mt-1 font-mono text-xs text-gray-500">{account.token_prefix ? `${account.token_prefix}…` : 'No active credential'} · last used {formatDate(account.last_used_at)} · expires {formatDate(account.expires_at)}</div><div className="mt-2 flex flex-wrap gap-1">{account.scopes.map((scope) => <span key={scope} className="rounded bg-gray-800 px-2 py-1 text-[10px] text-gray-400">{scope}</span>)}</div></div><div className="flex gap-2">{project.status === 'active' && <button onClick={() => void rotateAccount(account)} className="inline-flex items-center gap-2 rounded-lg border border-gray-700 px-3 py-2 text-sm text-gray-300 hover:border-cyan-500/40 hover:text-cyan-300"><RefreshCw size={15} /> Rotate</button>}{account.is_active && <button onClick={() => void revokeAccount(account)} className="inline-flex items-center gap-2 rounded-lg border border-red-500/20 px-3 py-2 text-sm text-red-300 hover:bg-red-500/10"><Trash2 size={15} /> Revoke</button>}</div></div>)}</div></div>
        </section>
      )}

      {showDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-2xl border border-red-500/30 bg-gray-900 p-6 shadow-2xl">
            <h2 className="text-xl font-semibold text-white">Delete project permanently</h2>
            <p className="mt-2 text-sm text-gray-400">This only succeeds after every project file, including trash, has been permanently removed. Type <strong className="font-mono text-red-300">{project.slug}</strong> to confirm.</p>
            <input autoFocus value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.target.value)} className="mt-5 w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2.5 font-mono text-white outline-none focus:border-red-500" />
            <div className="mt-5 flex justify-end gap-3">
              <button onClick={() => { setShowDelete(false); setDeleteConfirmation(''); }} className="rounded-lg px-4 py-2 text-gray-300 hover:bg-gray-800">Cancel</button>
              <button disabled={lifecycleBusy || deleteConfirmation !== project.slug} onClick={() => void deleteProject()} className="inline-flex items-center gap-2 rounded-lg bg-red-500 px-4 py-2 font-medium text-white disabled:opacity-40">{lifecycleBusy && <Loader2 className="animate-spin" size={16} />} Delete permanently</button>
            </div>
          </div>
        </div>
      )}

      {secret && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"><div className="w-full max-w-xl rounded-2xl border border-cyan-500/30 bg-gray-900 p-6 shadow-2xl"><div className="flex items-start justify-between"><div><h2 className="text-xl font-semibold text-white">Save this token now</h2><p className="mt-1 text-sm text-amber-300">It will not be shown again after this dialog closes.</p></div><button onClick={() => setSecret(null)} className="p-2 text-gray-400"><X size={20} /></button></div><div className="mt-5 rounded-xl border border-gray-700 bg-gray-950 p-4"><div className="mb-2 text-xs text-gray-500">{secret.name}</div><code className="break-all text-sm text-cyan-200">{secret.token}</code></div><div className="mt-5 flex justify-end gap-3"><button onClick={async () => { await navigator.clipboard.writeText(secret.token); setCopied(true); }} className="inline-flex items-center gap-2 rounded-lg border border-gray-700 px-4 py-2 text-gray-200">{copied ? <Check size={17} /> : <Copy size={17} />}{copied ? 'Copied' : 'Copy token'}</button><button onClick={() => { setSecret(null); setCopied(false); }} className="rounded-lg bg-cyan-500 px-4 py-2 font-medium text-gray-950">I saved it</button></div></div></div>
      )}

      {previewFile && (
        <FilePreviewModal
          file={previewFile}
          siblings={files}
          onSelect={(file) => setPreviewFile(file as ProjectFile)}
          onClose={() => setPreviewFile(null)}
          loadBlob={loadProjectPreview}
          enableVersions={false}
        />
      )}
    </div>
  );
}
