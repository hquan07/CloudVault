'use client';

import { FormEvent, useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertCircle, ArrowRight, FolderKanban, HardDrive, Loader2, Plus, X } from 'lucide-react';
import { ApiError, Project, projectApi } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { formatBytes } from '@/lib/utils';

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

export default function ProjectsPage() {
  const { user } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);

  const loadProjects = async () => {
    try {
      setError('');
      setProjects(await projectApi.list());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadProjects(); }, []);

  const createProject = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setCreating(true);
    setError('');
    try {
      const project = await projectApi.create({
        slug: String(form.get('slug')),
        name: String(form.get('name')),
        description: String(form.get('description') || ''),
        storage_quota: Number(form.get('quota_gb')) * 1024 ** 3,
        max_file_size: Number(form.get('max_file_mb')) * 1024 ** 2,
        warning_percent: Number(form.get('warning_percent')),
        retention_policy: { default_days: Number(form.get('retention_days')) },
      });
      setProjects((current) => [...current, project].sort((a, b) => a.name.localeCompare(b.name)));
      setShowCreate(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="max-w-7xl mx-auto space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <div className="rounded-xl bg-cyan-500/10 p-3 text-cyan-400"><FolderKanban size={26} /></div>
            <div>
              <h1 className="text-3xl font-bold text-white">Projects</h1>
              <p className="mt-1 text-sm text-gray-400">Storage isolated by project, role and quota.</p>
            </div>
          </div>
        </div>
        {user?.role === 'admin' && (
          <button onClick={() => setShowCreate(true)} className="inline-flex items-center justify-center gap-2 rounded-xl bg-cyan-500 px-4 py-2.5 font-medium text-gray-950 hover:bg-cyan-400">
            <Plus size={18} /> New project
          </button>
        )}
      </div>

      {error && (
        <div className="flex items-center gap-3 rounded-xl border border-red-500/20 bg-red-500/10 p-4 text-red-300">
          <AlertCircle size={19} /> {error}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-24"><Loader2 className="animate-spin text-cyan-400" size={32} /></div>
      ) : projects.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-700 bg-gray-900/40 p-16 text-center">
          <FolderKanban className="mx-auto mb-4 text-gray-600" size={48} />
          <h2 className="text-xl font-semibold text-white">No projects yet</h2>
          <p className="mx-auto mt-2 max-w-md text-gray-400">
            {user?.role === 'admin' ? 'Create the first isolated storage project to begin.' : 'Ask a project administrator to add you as a member.'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 xl:grid-cols-3">
          {projects.map((project) => {
            const percent = project.storage_quota ? Math.min(100, project.storage_used / project.storage_quota * 100) : 0;
            const warning = percent >= project.warning_percent;
            return (
              <Link key={project.id} href={`/dashboard/projects/${project.id}`} className="group rounded-2xl border border-gray-800 bg-gray-900 p-6 transition hover:-translate-y-0.5 hover:border-cyan-500/40">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-lg font-semibold text-white group-hover:text-cyan-300">{project.name}</h2>
                    <p className="mt-1 font-mono text-xs text-gray-500">{project.slug}</p>
                  </div>
                  <span className="rounded-full border border-gray-700 px-2.5 py-1 text-xs capitalize text-gray-300">{project.member_role}</span>
                </div>
                <p className="mt-4 line-clamp-2 min-h-10 text-sm text-gray-400">{project.description || 'No description provided.'}</p>
                <div className="mt-6">
                  <div className="mb-2 flex justify-between text-xs text-gray-400">
                    <span className="inline-flex items-center gap-1"><HardDrive size={13} /> {formatBytes(project.storage_used)}</span>
                    <span>{formatBytes(project.storage_quota)}</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-gray-800">
                    <div className={`h-full rounded-full ${warning ? 'bg-amber-500' : 'bg-cyan-500'}`} style={{ width: `${percent}%` }} />
                  </div>
                </div>
                <div className="mt-5 flex items-center justify-between text-xs text-gray-500">
                  <span className="capitalize">{project.status}</span>
                  <span className="inline-flex items-center gap-1 text-cyan-400">Open <ArrowRight size={14} /></span>
                </div>
              </Link>
            );
          })}
        </div>
      )}

      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="w-full max-w-xl rounded-2xl border border-gray-700 bg-gray-900 p-6 shadow-2xl">
            <div className="mb-6 flex items-center justify-between">
              <div><h2 className="text-xl font-semibold text-white">Create project</h2><p className="mt-1 text-sm text-gray-400">Set the initial storage boundary and retention policy.</p></div>
              <button onClick={() => setShowCreate(false)} className="rounded-lg p-2 text-gray-400 hover:bg-gray-800"><X size={20} /></button>
            </div>
            <form onSubmit={createProject} className="grid grid-cols-2 gap-4">
              <label className="col-span-2 text-sm text-gray-300">Name<input required name="name" minLength={2} className="mt-1.5 w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2.5 text-white outline-none focus:border-cyan-500" /></label>
              <label className="col-span-2 text-sm text-gray-300">Slug<input required name="slug" minLength={2} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" placeholder="news-flow" className="mt-1.5 w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2.5 font-mono text-white outline-none focus:border-cyan-500" /></label>
              <label className="col-span-2 text-sm text-gray-300">Description<textarea name="description" rows={2} className="mt-1.5 w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2.5 text-white outline-none focus:border-cyan-500" /></label>
              <label className="text-sm text-gray-300">Quota (GB)<input required name="quota_gb" type="number" min="0.01" step="0.01" defaultValue="10" className="mt-1.5 w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2.5 text-white" /></label>
              <label className="text-sm text-gray-300">Max file (MB)<input required name="max_file_mb" type="number" min="1" defaultValue="500" className="mt-1.5 w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2.5 text-white" /></label>
              <label className="text-sm text-gray-300">Warning at (%)<input required name="warning_percent" type="number" min="1" max="100" defaultValue="80" className="mt-1.5 w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2.5 text-white" /></label>
              <label className="text-sm text-gray-300">Retention (days)<input required name="retention_days" type="number" min="1" defaultValue="90" className="mt-1.5 w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2.5 text-white" /></label>
              <div className="col-span-2 mt-2 flex justify-end gap-3">
                <button type="button" onClick={() => setShowCreate(false)} className="rounded-lg px-4 py-2 text-gray-300 hover:bg-gray-800">Cancel</button>
                <button disabled={creating} className="inline-flex items-center gap-2 rounded-lg bg-cyan-500 px-4 py-2 font-medium text-gray-950 disabled:opacity-50">{creating && <Loader2 className="animate-spin" size={16} />} Create</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
