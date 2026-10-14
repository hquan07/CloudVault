'use client';

import { type ChangeEvent, type InputHTMLAttributes, useRef, useState } from 'react';
import { FolderUp, Loader2, Play, RefreshCw, Trash2, Upload, X } from 'lucide-react';
import { ApiError, ProjectFolder, projectApi } from '@/lib/api';
import { formatBytes } from '@/lib/utils';

type UploadStatus = 'queued' | 'uploading' | 'done' | 'error' | 'cancelled';

interface UploadTask {
  id: string;
  file: File;
  relativePath: string;
  idempotencyKey: string;
  status: UploadStatus;
  progress: number;
  error?: string;
}

interface Props {
  projectId: string;
  currentFolderId: string | null;
  onComplete: () => Promise<void> | void;
}

const MULTIPART_THRESHOLD = 16 * 1024 * 1024;

function messageFrom(error: unknown): string {
  if (error instanceof ApiError) {
    const detail = error.data.detail;
    if (detail && typeof detail === 'object' && 'message' in detail) {
      return String((detail as { message: unknown }).message);
    }
    if (typeof detail === 'string') return detail;
  }
  if (error instanceof Error) return error.message;
  return 'Upload failed';
}

export function ProjectUploadQueue({ projectId, currentFolderId, onComplete }: Props) {
  const [tasks, setTasks] = useState<UploadTask[]>([]);
  const [artifactType, setArtifactType] = useState('document');
  const [retentionClass, setRetentionClass] = useState('default');
  const [running, setRunning] = useState(false);
  const controllers = useRef(new Map<string, AbortController>());

  const updateTask = (id: string, patch: Partial<UploadTask>) => {
    setTasks((current) => current.map((task) => task.id === id ? { ...task, ...patch } : task));
  };

  const addFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = [...(event.target.files || [])];
    if (!selected.length) return;
    setTasks((current) => [
      ...current,
      ...selected.map((file) => ({
        id: crypto.randomUUID(),
        file,
        relativePath: file.webkitRelativePath || file.name,
        idempotencyKey: crypto.randomUUID(),
        status: 'queued' as const,
        progress: 0,
      })),
    ]);
    event.target.value = '';
  };

  const ensureFolderPath = async (
    relativePath: string,
    folderCache: Map<string, ProjectFolder>,
  ): Promise<string | null> => {
    const segments = relativePath.split('/').filter(Boolean).slice(0, -1);
    let parentId = currentFolderId;
    let cachePath = currentFolderId || 'root';
    for (const name of segments) {
      cachePath = `${cachePath}/${name}`;
      const cached = folderCache.get(cachePath);
      if (cached) {
        parentId = cached.id;
        continue;
      }
      const siblings = await projectApi.listFolders(projectId, parentId);
      let folder = siblings.folders.find((item) => item.name === name);
      if (!folder) folder = await projectApi.createFolder(projectId, name, parentId);
      folderCache.set(cachePath, folder);
      parentId = folder.id;
    }
    return parentId;
  };

  const uploadTask = async (
    task: UploadTask,
    destinationFolderId: string | null,
  ): Promise<boolean> => {
    const controller = new AbortController();
    controllers.current.set(task.id, controller);
    updateTask(task.id, { status: 'uploading', progress: 0, error: undefined });
    const metadata = {
      artifact_type: artifactType,
      retention_class: retentionClass,
      logical_date: new Date().toISOString(),
      source_run_id: task.idempotencyKey,
    };
    try {
      if (task.file.size >= MULTIPART_THRESHOLD) {
        await projectApi.uploadMultipartWithProgress(
          projectId, task.file, metadata,
          (progress) => updateTask(task.id, { progress }),
          controller.signal, destinationFolderId, task.idempotencyKey,
        );
      } else {
        await projectApi.uploadWithProgress(
          projectId, task.file, metadata,
          (progress) => updateTask(task.id, { progress }),
          controller.signal, destinationFolderId, task.idempotencyKey,
        );
      }
      updateTask(task.id, { status: 'done', progress: 100 });
      return true;
    } catch (error) {
      const cancelled = error instanceof DOMException && error.name === 'AbortError';
      updateTask(task.id, {
        status: cancelled ? 'cancelled' : 'error',
        error: cancelled ? 'Upload cancelled' : messageFrom(error),
      });
      return false;
    } finally {
      controllers.current.delete(task.id);
    }
  };

  const startTasks = async (selectedTasks: UploadTask[]) => {
    if (!selectedTasks.length || running) return;
    setRunning(true);
    const folderCache = new Map<string, ProjectFolder>();
    const prepared: { task: UploadTask; folderId: string | null }[] = [];
    for (const task of selectedTasks) {
      try {
        const folderId = await ensureFolderPath(task.relativePath, folderCache);
        prepared.push({ task, folderId });
      } catch (error) {
        updateTask(task.id, { status: 'error', error: messageFrom(error) });
      }
    }

    let next = 0;
    let completedAny = false;
    const workers = Array.from({ length: Math.min(2, prepared.length) }, async () => {
      while (next < prepared.length) {
        const item = prepared[next++];
        if (await uploadTask(item.task, item.folderId)) completedAny = true;
      }
    });
    await Promise.all(workers);
    if (completedAny) await onComplete();
    setRunning(false);
  };

  const retryTask = async (task: UploadTask) => {
    if (running) return;
    setRunning(true);
    try {
      const folderId = await ensureFolderPath(task.relativePath, new Map());
      const completed = await uploadTask(task, folderId);
      if (completed) await onComplete();
    } catch (error) {
      updateTask(task.id, { status: 'error', error: messageFrom(error) });
    } finally {
      setRunning(false);
    }
  };

  const pending = tasks.filter((task) => task.status === 'queued');

  return (
    <div className="space-y-4 rounded-2xl border border-gray-800 bg-gray-900 p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h2 className="font-semibold text-white">Upload queue</h2>
          <p className="mt-1 text-sm text-gray-500">Files above 16 MB use resumable multipart upload automatically.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-gray-700 px-3 py-2 text-sm text-gray-300 hover:border-cyan-500/40 hover:text-cyan-300">
            <Upload size={16} /> Add files
            <input multiple type="file" onChange={addFiles} className="hidden" />
          </label>
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-gray-700 px-3 py-2 text-sm text-gray-300 hover:border-cyan-500/40 hover:text-cyan-300">
            <FolderUp size={16} /> Add folder
            <input
              multiple type="file" onChange={addFiles} className="hidden"
              {...({ webkitdirectory: '', directory: '' } as InputHTMLAttributes<HTMLInputElement>)}
            />
          </label>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm text-gray-300">Artifact type<input value={artifactType} onChange={(event) => setArtifactType(event.target.value)} className="mt-1.5 w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-white" /></label>
        <label className="text-sm text-gray-300">Retention class<select value={retentionClass} onChange={(event) => setRetentionClass(event.target.value)} className="mt-1.5 w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-white"><option value="default">default</option><option value="temporary">temporary</option><option value="archive">archive</option></select></label>
      </div>

      {tasks.length > 0 && (
        <div className="space-y-2">
          {tasks.map((task) => (
            <div key={task.id} className="rounded-xl border border-gray-800 bg-gray-950/70 p-3">
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-gray-200">{task.relativePath}</div>
                  <div className="mt-1 text-xs text-gray-500">{formatBytes(task.file.size)} · {task.status}</div>
                </div>
                {task.status === 'uploading' && <button onClick={() => controllers.current.get(task.id)?.abort()} title="Cancel" className="rounded-lg p-2 text-gray-400 hover:bg-red-500/10 hover:text-red-300"><X size={16} /></button>}
                {(task.status === 'error' || task.status === 'cancelled') && <button disabled={running} onClick={() => void retryTask(task)} title="Retry" className="rounded-lg p-2 text-gray-400 hover:bg-cyan-500/10 hover:text-cyan-300 disabled:opacity-40"><RefreshCw size={16} /></button>}
                {task.status !== 'uploading' && <button onClick={() => setTasks((current) => current.filter((item) => item.id !== task.id))} title="Remove from queue" className="rounded-lg p-2 text-gray-500 hover:bg-red-500/10 hover:text-red-300"><Trash2 size={16} /></button>}
              </div>
              {(task.status === 'uploading' || task.status === 'done') && <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-gray-800"><div className={`h-full ${task.status === 'done' ? 'bg-emerald-500' : 'bg-cyan-500'}`} style={{ width: `${task.progress}%` }} /></div>}
              {task.error && <p className="mt-2 text-xs text-red-300">{task.error}</p>}
            </div>
          ))}
          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <button onClick={() => setTasks((current) => current.filter((task) => task.status !== 'done'))} className="rounded-lg border border-gray-700 px-3 py-2 text-sm text-gray-400 hover:text-white">Clear completed</button>
            <button disabled={running || pending.length === 0} onClick={() => void startTasks(pending)} className="inline-flex items-center gap-2 rounded-lg bg-cyan-500 px-4 py-2 text-sm font-medium text-gray-950 disabled:opacity-40">{running ? <Loader2 className="animate-spin" size={16} /> : <Play size={16} />} Upload {pending.length || ''}</button>
          </div>
        </div>
      )}
    </div>
  );
}
