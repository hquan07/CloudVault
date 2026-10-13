'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  AlertCircle, ArrowLeft, Check, Copy, Download, File, HardDrive, KeyRound,
  Loader2, RefreshCw, Shield, Trash2, Upload, UserPlus, X,
} from 'lucide-react';
import {
  ApiError, Project, ProjectFile, ProjectMember, ProjectUsage, ServiceAccount, projectApi,
} from '@/lib/api';
import { formatBytes } from '@/lib/utils';

type Tab = 'files' | 'members' | 'access' | 'policy';

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const detail = error.data.detail;
    if (typeof detail === 'object' && detail && 'message' in detail) {
      return String((detail as { message: unknown }).message);
    }
    if (typeof detail === 'string') return detail;
    return error.message;
  }
  return 'Unable to complete the request.';
}

function formatDate(value: string | null): string {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Never';
}

export default function ProjectDetailPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const [project, setProject] = useState<Project | null>(null);
  const [usage, setUsage] = useState<ProjectUsage | null>(null);
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [accounts, setAccounts] = useState<ServiceAccount[]>([]);
  const [tab, setTab] = useState<Tab>('files');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [secret, setSecret] = useState<{ name: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const loadData = useCallback(async () => {
    try {
      setError('');
      const [projectData, usageData, fileData, memberData] = await Promise.all([
        projectApi.get(projectId), projectApi.getUsage(projectId),
        projectApi.listFiles(projectId), projectApi.listMembers(projectId),
      ]);
      setProject(projectData);
      setUsage(usageData);
      setFiles(fileData.files);
      setMembers(memberData);
      if (projectData.member_role === 'admin') {
        setAccounts(await projectApi.listServiceAccounts(projectId));
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void loadData(); }, [loadData]);

  const canWrite = project?.member_role === 'editor' || project?.member_role === 'admin';
  const isAdmin = project?.member_role === 'admin';

  const uploadFile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const selected = form.get('file');
    if (!(selected instanceof window.File) || !selected.name) return;
    setUploading(true);
    setUploadProgress(0);
    setError('');
    try {
      await projectApi.uploadWithProgress(projectId, selected, {
        artifact_type: String(form.get('artifact_type')),
        retention_class: String(form.get('retention_class')),
        logical_date: new Date().toISOString(),
        source_run_id: crypto.randomUUID(),
      }, setUploadProgress);
      formElement.reset();
      await loadData();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setUploading(false);
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

  const deleteFile = async (item: ProjectFile) => {
    if (!window.confirm(`Move ${item.original_name} to project trash?`)) return;
    try {
      await projectApi.deleteFile(projectId, item.id);
      setFiles((current) => current.filter((file) => file.id !== item.id));
    } catch (err) { setError(errorMessage(err)); }
  };

  const addMember = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      const member = await projectApi.addMember(
        projectId, String(form.get('user_id')), String(form.get('role')) as ProjectMember['role'],
      );
      setMembers((current) => [...current, member].sort((a, b) => a.username.localeCompare(b.username)));
      formElement.reset();
    } catch (err) { setError(errorMessage(err)); }
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

  const createAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const scopes = form.getAll('scopes').map(String);
    try {
      const account = await projectApi.createServiceAccount(projectId, { name: String(form.get('name')), scopes });
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
  const tabs: { id: Tab; label: string }[] = [
    { id: 'files', label: 'Files' }, { id: 'members', label: 'Members' }, { id: 'policy', label: 'Policy' },
    ...(isAdmin ? [{ id: 'access' as Tab, label: 'Service accounts' }] : []),
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
          <div className="w-full max-w-md rounded-xl border border-gray-800 bg-gray-950/60 p-4">
            <div className="mb-2 flex justify-between text-sm"><span className="inline-flex items-center gap-2 text-gray-300"><HardDrive size={16} /> Project storage</span><span className="text-gray-400">{usagePercent.toFixed(1)}%</span></div>
            <div className="h-2.5 overflow-hidden rounded-full bg-gray-800"><div className={`h-full ${usagePercent >= project.warning_percent ? 'bg-amber-500' : 'bg-cyan-500'}`} style={{ width: `${usagePercent}%` }} /></div>
            <div className="mt-2 flex justify-between text-xs text-gray-500"><span>{formatBytes(usage?.storage_used || 0)} used</span><span>{formatBytes(usage?.storage_quota || 0)} total</span></div>
          </div>
        </div>
      </div>

      {error && <div className="flex items-center justify-between rounded-xl border border-red-500/20 bg-red-500/10 p-4 text-red-300"><span className="flex items-center gap-3"><AlertCircle size={18} />{error}</span><button onClick={() => setError('')}><X size={17} /></button></div>}

      <div className="flex gap-2 overflow-x-auto border-b border-gray-800">
        {tabs.map((item) => <button key={item.id} onClick={() => setTab(item.id)} className={`whitespace-nowrap border-b-2 px-4 py-3 text-sm ${tab === item.id ? 'border-cyan-400 text-cyan-300' : 'border-transparent text-gray-400 hover:text-white'}`}>{item.label}</button>)}
      </div>

      {tab === 'files' && (
        <section className="space-y-5">
          {canWrite && project.status === 'active' && (
            <form onSubmit={uploadFile} className="grid gap-3 rounded-2xl border border-gray-800 bg-gray-900 p-5 md:grid-cols-[1fr_180px_180px_auto] md:items-end">
              <label className="text-sm text-gray-300">File<input required name="file" type="file" className="mt-1.5 block w-full rounded-lg border border-gray-700 bg-gray-950 p-2 text-sm text-gray-300 file:mr-3 file:rounded-md file:border-0 file:bg-cyan-500/10 file:px-3 file:py-1 file:text-cyan-300" /></label>
              <label className="text-sm text-gray-300">Artifact type<input required name="artifact_type" defaultValue="document" className="mt-1.5 w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-white" /></label>
              <label className="text-sm text-gray-300">Retention class<select name="retention_class" className="mt-1.5 w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-white"><option value="default">default</option><option value="temporary">temporary</option><option value="archive">archive</option></select></label>
              <button disabled={uploading} className="inline-flex items-center justify-center gap-2 rounded-lg bg-cyan-500 px-4 py-2 font-medium text-gray-950 disabled:opacity-50">{uploading ? <Loader2 className="animate-spin" size={17} /> : <Upload size={17} />}{uploading ? `${uploadProgress}%` : 'Upload'}</button>
            </form>
          )}
          {files.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-gray-700 p-14 text-center text-gray-400"><File className="mx-auto mb-3 text-gray-600" size={42} /><p>No files in this project.</p>{!canWrite && <p className="mt-1 text-xs">Your viewer role is read-only.</p>}</div>
          ) : (
            <div className="overflow-hidden rounded-2xl border border-gray-800 bg-gray-900">
              <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="border-b border-gray-800 text-xs uppercase text-gray-500"><tr><th className="p-4">File</th><th className="p-4">Artifact</th><th className="p-4">Size</th><th className="p-4">Uploaded</th><th className="p-4 text-right">Actions</th></tr></thead><tbody className="divide-y divide-gray-800">{files.map((item) => <tr key={item.id} className="hover:bg-gray-800/40"><td className="p-4"><div className="font-medium text-gray-100">{item.original_name}</div><div className="mt-1 font-mono text-[11px] text-gray-600">{item.checksum_sha256.slice(0, 16)}…</div></td><td className="p-4 text-gray-400">{String(item.metadata.artifact_type || '—')}</td><td className="p-4 text-gray-400">{formatBytes(item.size)}</td><td className="p-4 text-gray-400">{formatDate(item.created_at)}</td><td className="p-4"><div className="flex justify-end gap-1"><button onClick={() => void downloadFile(item)} title="Download" className="rounded-lg p-2 text-gray-400 hover:bg-cyan-500/10 hover:text-cyan-300"><Download size={17} /></button>{canWrite && <button onClick={() => void deleteFile(item)} title="Move to trash" className="rounded-lg p-2 text-gray-400 hover:bg-red-500/10 hover:text-red-300"><Trash2 size={17} /></button>}</div></td></tr>)}</tbody></table></div>
            </div>
          )}
        </section>
      )}

      {tab === 'members' && (
        <section className="space-y-5">
          {isAdmin && <form onSubmit={addMember} className="grid gap-3 rounded-2xl border border-gray-800 bg-gray-900 p-5 md:grid-cols-[1fr_180px_auto] md:items-end"><label className="text-sm text-gray-300">User ID<input required name="user_id" placeholder="UUID of an active user" className="mt-1.5 w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-white" /></label><label className="text-sm text-gray-300">Role<select name="role" className="mt-1.5 w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-white"><option value="viewer">Viewer</option><option value="editor">Editor</option><option value="admin">Admin</option></select></label><button className="inline-flex items-center justify-center gap-2 rounded-lg bg-cyan-500 px-4 py-2 font-medium text-gray-950"><UserPlus size={17} /> Add member</button></form>}
          <div className="overflow-hidden rounded-2xl border border-gray-800 bg-gray-900"><div className="divide-y divide-gray-800">{members.map((member) => <div key={member.id} className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between"><div className="flex items-center gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-full bg-gray-800 font-semibold text-gray-300">{member.username.charAt(0).toUpperCase()}</div><div><div className="font-medium text-white">{member.username}</div><div className="text-sm text-gray-500">{member.email}</div></div></div><div className="flex items-center gap-2">{isAdmin ? <select value={member.role} onChange={(event) => void changeMemberRole(member, event.target.value as ProjectMember['role'])} className="rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm capitalize text-white"><option value="viewer">Viewer</option><option value="editor">Editor</option><option value="admin">Admin</option></select> : <span className="rounded-full border border-gray-700 px-3 py-1 text-xs capitalize text-gray-300">{member.role}</span>}{isAdmin && <button onClick={() => void removeMember(member)} className="rounded-lg p-2 text-gray-500 hover:bg-red-500/10 hover:text-red-300"><Trash2 size={17} /></button>}</div></div>)}</div></div>
        </section>
      )}

      {tab === 'policy' && (
        <section className="grid gap-5 md:grid-cols-3"><div className="rounded-2xl border border-gray-800 bg-gray-900 p-5"><div className="text-sm text-gray-500">Maximum file size</div><div className="mt-2 text-xl font-semibold text-white">{formatBytes(project.max_file_size)}</div></div><div className="rounded-2xl border border-gray-800 bg-gray-900 p-5"><div className="text-sm text-gray-500">Quota warning</div><div className="mt-2 text-xl font-semibold text-white">{project.warning_percent}%</div></div><div className="rounded-2xl border border-gray-800 bg-gray-900 p-5"><div className="text-sm text-gray-500">Available storage</div><div className="mt-2 text-xl font-semibold text-white">{formatBytes(usage?.available_bytes || 0)}</div></div><div className="rounded-2xl border border-gray-800 bg-gray-900 p-5 md:col-span-3"><h2 className="font-medium text-white">Retention policy</h2><pre className="mt-3 overflow-x-auto rounded-xl bg-gray-950 p-4 text-sm text-gray-300">{JSON.stringify(project.retention_policy || {}, null, 2)}</pre></div></section>
      )}

      {tab === 'access' && isAdmin && (
        <section className="space-y-5">
          <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-amber-200"><Shield className="mr-2 inline" size={17} />Tokens grant machine access only to this project. A raw token is shown once after creation or rotation.</div>
          <form onSubmit={createAccount} className="rounded-2xl border border-gray-800 bg-gray-900 p-5"><div className="grid gap-4 lg:grid-cols-[1fr_2fr_auto] lg:items-end"><label className="text-sm text-gray-300">Account name<input required name="name" minLength={2} placeholder="news-flow-worker" className="mt-1.5 w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-white" /></label><fieldset><legend className="mb-2 text-sm text-gray-300">Scopes</legend><div className="flex flex-wrap gap-3">{['files:create', 'files:read', 'files:delete', 'project:usage:read'].map((scope) => <label key={scope} className="flex items-center gap-2 text-xs text-gray-400"><input type="checkbox" name="scopes" value={scope} defaultChecked={scope !== 'files:delete'} className="accent-cyan-500" />{scope}</label>)}</div></fieldset><button className="inline-flex items-center justify-center gap-2 rounded-lg bg-cyan-500 px-4 py-2 font-medium text-gray-950"><KeyRound size={17} /> Create token</button></div></form>
          <div className="overflow-hidden rounded-2xl border border-gray-800 bg-gray-900"><div className="divide-y divide-gray-800">{accounts.length === 0 ? <div className="p-10 text-center text-gray-500">No service accounts.</div> : accounts.map((account) => <div key={account.id} className="flex flex-col gap-4 p-5 lg:flex-row lg:items-center lg:justify-between"><div><div className="flex items-center gap-2"><span className="font-medium text-white">{account.name}</span><span className={`rounded-full px-2 py-0.5 text-[11px] ${account.is_active ? 'bg-emerald-500/10 text-emerald-300' : 'bg-red-500/10 text-red-300'}`}>{account.is_active ? 'active' : 'revoked'}</span></div><div className="mt-1 font-mono text-xs text-gray-500">{account.token_prefix ? `${account.token_prefix}…` : 'No active credential'} · last used {formatDate(account.last_used_at)}</div><div className="mt-2 flex flex-wrap gap-1">{account.scopes.map((scope) => <span key={scope} className="rounded bg-gray-800 px-2 py-1 text-[10px] text-gray-400">{scope}</span>)}</div></div><div className="flex gap-2"><button onClick={() => void rotateAccount(account)} className="inline-flex items-center gap-2 rounded-lg border border-gray-700 px-3 py-2 text-sm text-gray-300 hover:border-cyan-500/40 hover:text-cyan-300"><RefreshCw size={15} /> Rotate</button>{account.is_active && <button onClick={() => void revokeAccount(account)} className="inline-flex items-center gap-2 rounded-lg border border-red-500/20 px-3 py-2 text-sm text-red-300 hover:bg-red-500/10"><Trash2 size={15} /> Revoke</button>}</div></div>)}</div></div>
        </section>
      )}

      {secret && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"><div className="w-full max-w-xl rounded-2xl border border-cyan-500/30 bg-gray-900 p-6 shadow-2xl"><div className="flex items-start justify-between"><div><h2 className="text-xl font-semibold text-white">Save this token now</h2><p className="mt-1 text-sm text-amber-300">It will not be shown again after this dialog closes.</p></div><button onClick={() => setSecret(null)} className="p-2 text-gray-400"><X size={20} /></button></div><div className="mt-5 rounded-xl border border-gray-700 bg-gray-950 p-4"><div className="mb-2 text-xs text-gray-500">{secret.name}</div><code className="break-all text-sm text-cyan-200">{secret.token}</code></div><div className="mt-5 flex justify-end gap-3"><button onClick={async () => { await navigator.clipboard.writeText(secret.token); setCopied(true); }} className="inline-flex items-center gap-2 rounded-lg border border-gray-700 px-4 py-2 text-gray-200">{copied ? <Check size={17} /> : <Copy size={17} />}{copied ? 'Copied' : 'Copy token'}</button><button onClick={() => { setSecret(null); setCopied(false); }} className="rounded-lg bg-cyan-500 px-4 py-2 font-medium text-gray-950">I saved it</button></div></div></div>
      )}
    </div>
  );
}
