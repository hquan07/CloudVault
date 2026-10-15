'use client';

import { useState, useEffect } from 'react';
import { Star, File as FileIcon, Download, FolderKanban, Share2 } from 'lucide-react';
import { metaApi, fileApi, ProjectFile, projectApi } from '@/lib/api';
import { formatBytes, formatRelative } from '@/lib/utils';
import { FilePreviewModal } from '@/components/FilePreviewModal';
import { ShareModal } from '@/components/ShareModal';
import { FileItem } from '@/app/dashboard/page';

export default function StarredPage() {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [projectFiles, setProjectFiles] = useState<ProjectFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [previewFile, setPreviewFile] = useState<FileItem | null>(null);
  const [previewProjectFile, setPreviewProjectFile] = useState<ProjectFile | null>(null);
  const [shareFile, setShareFile] = useState<FileItem | null>(null);

  const loadStarred = async () => {
    setLoading(true);
    const [personalResult, projectResult] = await Promise.allSettled([
      metaApi.listFiles({ is_starred: true, sort_by: 'updated_at', sort_order: 'desc', page_size: 50 }) as Promise<{ files: FileItem[] }>,
      projectApi.listStarredFiles(),
    ]);
    setFiles(personalResult.status === 'fulfilled' ? personalResult.value.files || [] : []);
    setProjectFiles(projectResult.status === 'fulfilled' ? projectResult.value.files || [] : []);
    setLoading(false);
  };

  useEffect(() => { loadStarred(); }, []);

  const handleDownload = async (fileId: string) => {
    try {
      const data = await fileApi.download(fileId);
      window.location.href = data.download_url;
    } catch { /* silent */ }
  };

  const handleUnstar = async (fileId: string) => {
    try {
      await metaApi.updateFile(fileId, { is_starred: false });
      setFiles(prev => prev.filter(f => f.id !== fileId));
    } catch { /* silent */ }
  };

  const handleProjectDownload = async (file: ProjectFile) => {
    try {
      const blob = await projectApi.downloadFile(file.project_id, file.id);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = file.original_name;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch { /* silent */ }
  };

  const handleProjectUnstar = async (file: ProjectFile) => {
    try {
      await projectApi.unstarFile(file.project_id, file.id);
      setProjectFiles((current) => current.filter((item) => item.id !== file.id));
    } catch { /* silent */ }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <h1 className="text-2xl font-bold flex items-center gap-3">
          <Star className="fill-yellow-500 text-yellow-500" size={28} /> Starred Files
        </h1>
        <span className="text-gray-500">Your favorite files</span>
      </div>
      
      {loading ? (
        <div className="p-12 text-center text-gray-500">Loading starred files...</div>
      ) : files.length === 0 && projectFiles.length === 0 ? (
        <div className="text-center py-24 px-8 border-2 border-dashed border-gray-800 rounded-2xl bg-gray-900/30">
          <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-yellow-500/10 flex items-center justify-center text-yellow-500">
            <Star size={32} />
          </div>
          <h3 className="text-xl font-medium text-gray-200 mb-2">No starred files</h3>
          <p className="text-gray-500 max-w-sm mx-auto mb-6">Star important files for quick access.</p>
        </div>
      ) : files.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {files.map(file => (
            <div 
              key={file.id} 
              className="group bg-gray-900 border border-yellow-500/30 rounded-2xl p-5 hover:border-yellow-400/60 transition-all hover:shadow-lg hover:shadow-yellow-900/10 cursor-pointer"
              onClick={() => setPreviewFile(file)}
            >
              <div className="flex items-start justify-between mb-4">
                <div className="w-12 h-12 rounded-xl bg-yellow-500/10 flex items-center justify-center text-yellow-500">
                  <FileIcon size={24} />
                </div>
                <div className="flex space-x-1 transition-opacity opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                  <button 
                    onClick={(e) => { e.stopPropagation(); handleUnstar(file.id); }} 
                    className="p-2 text-yellow-500 hover:bg-gray-800 rounded-lg transition-colors"
                    title="Remove star"
                  >
                    <Star size={18} className="fill-current" />
                  </button>
                  <button 
                    onClick={(e) => { e.stopPropagation(); setShareFile(file); }}
                    className="p-2 text-gray-400 hover:text-cyan-400 hover:bg-gray-800 rounded-lg transition-colors"
                  >
                    <Share2 size={18} />
                  </button>
                  <button 
                    onClick={(e) => { e.stopPropagation(); handleDownload(file.id); }} 
                    className="p-2 text-gray-400 hover:text-cyan-400 hover:bg-gray-800 rounded-lg transition-colors"
                  >
                    <Download size={18} />
                  </button>
                </div>
              </div>
              
              <h4 className="font-medium text-gray-200 truncate mb-1" title={file.original_name}>
                {file.original_name}
              </h4>
              
              <div className="flex items-center justify-between text-xs text-gray-500">
                <span>{formatBytes(file.size)}</span>
                <span>{formatRelative(file.updated_at)}</span>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {!loading && projectFiles.length > 0 && (
        <section className="space-y-4">
          <div className="flex items-center gap-2 text-sm font-medium text-gray-300"><FolderKanban size={18} className="text-cyan-400" /> Project files</div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {projectFiles.map((file) => (
              <div key={file.id} onClick={() => setPreviewProjectFile(file)} className="group cursor-pointer rounded-2xl border border-cyan-500/25 bg-gray-900 p-5 transition-all hover:border-cyan-400/60 hover:shadow-lg hover:shadow-cyan-900/10">
                <div className="mb-4 flex items-start justify-between">
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-cyan-500/10 text-cyan-400"><FileIcon size={24} /></div>
                  <div className="flex space-x-1 transition-opacity opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                    <button onClick={(event) => { event.stopPropagation(); void handleProjectUnstar(file); }} className="rounded-lg p-2 text-yellow-500 transition-colors hover:bg-gray-800" title="Remove star"><Star size={18} className="fill-current" /></button>
                    <button onClick={(event) => { event.stopPropagation(); void handleProjectDownload(file); }} className="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-800 hover:text-cyan-400" title="Download"><Download size={18} /></button>
                  </div>
                </div>
                <h4 className="mb-1 truncate font-medium text-gray-200" title={file.original_name}>{file.original_name}</h4>
                <p className="mb-3 truncate text-xs text-cyan-400">{file.project_name || file.project_slug}</p>
                <div className="flex items-center justify-between text-xs text-gray-500"><span>{formatBytes(file.size)}</span><span>{formatRelative(file.updated_at)}</span></div>
              </div>
            ))}
          </div>
        </section>
      )}

      {previewFile && (
        <FilePreviewModal file={previewFile} onClose={() => setPreviewFile(null)} />
      )}
      {previewProjectFile && (
        <FilePreviewModal
          file={previewProjectFile}
          siblings={projectFiles}
          onSelect={(file) => setPreviewProjectFile(file as ProjectFile)}
          onClose={() => setPreviewProjectFile(null)}
          loadBlob={(file) => projectApi.downloadFile((file as ProjectFile).project_id, file.id)}
          enableVersions={false}
        />
      )}
      {shareFile && (
        <ShareModal file={shareFile} onClose={() => setShareFile(null)} />
      )}
    </div>
  );
}
