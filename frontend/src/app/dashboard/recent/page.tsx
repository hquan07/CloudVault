'use client';

import { useState, useEffect } from 'react';
import { Clock, FolderOpen, File as FileIcon, Download, Trash2, Share2, Star } from 'lucide-react';
import { metaApi, fileApi } from '@/lib/api';
import { formatBytes, formatRelative } from '@/lib/utils';
import { FilePreviewModal } from '@/components/FilePreviewModal';
import { ShareModal } from '@/components/ShareModal';
import { FileItem } from '@/app/dashboard/page';

export default function RecentPage() {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [previewFile, setPreviewFile] = useState<FileItem | null>(null);
  const [shareFile, setShareFile] = useState<FileItem | null>(null);

  useEffect(() => {
    const loadRecent = async () => {
      setLoading(true);
      try {
        const data = await metaApi.listFiles({ sort_by: 'updated_at', sort_order: 'desc', page_size: 20 }) as { files: FileItem[] };
        setFiles(data.files || []);
      } catch { /* silent */ }
      setLoading(false);
    };
    loadRecent();
  }, []);

  const handleDownload = async (fileId: string) => {
    try {
      const data = await fileApi.download(fileId);
      window.location.href = data.download_url;
    } catch { /* silent */ }
  };

  const handleToggleStar = async (fileId: string, currentStatus: boolean) => {
    try {
      await metaApi.updateFile(fileId, { is_starred: !currentStatus });
      setFiles(files.map(f => f.id === fileId ? { ...f, is_starred: !currentStatus } : f));
    } catch { /* silent */ }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <h1 className="text-2xl font-bold">Recent Files</h1>
        <span className="text-gray-500">Recently opened or modified</span>
      </div>
      
      {loading ? (
        <div className="p-12 text-center text-gray-500">Loading recent files...</div>
      ) : files.length === 0 ? (
        <div className="text-center py-24 px-8 border-2 border-dashed border-gray-800 rounded-2xl bg-gray-900/30">
          <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-gray-800 flex items-center justify-center text-gray-400">
            <Clock size={32} />
          </div>
          <h3 className="text-xl font-medium text-gray-200 mb-2">No recent files</h3>
          <p className="text-gray-500 max-w-sm mx-auto mb-6">Files you&apos;ve recently modified will appear here.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {files.map(file => (
            <div 
              key={file.id} 
              className="group bg-gray-900 border border-gray-800 rounded-2xl p-5 hover:border-cyan-500/30 transition-all hover:shadow-lg hover:shadow-cyan-900/10 cursor-pointer"
              onClick={() => setPreviewFile(file)}
            >
              <div className="flex items-start justify-between mb-4">
                <div className="w-12 h-12 rounded-xl bg-gray-800 flex items-center justify-center text-cyan-400">
                  <FileIcon size={24} />
                </div>
                <div className="flex space-x-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button 
                    onClick={(e) => { e.stopPropagation(); handleToggleStar(file.id, !!file.is_starred); }}
                    className={`p-2 rounded-lg transition-colors ${file.is_starred ? 'text-yellow-500 hover:bg-gray-800' : 'text-gray-400 hover:text-yellow-500 hover:bg-gray-800'}`}
                    title={file.is_starred ? "Unstar" : "Star"}
                  >
                    <Star size={18} className={file.is_starred ? "fill-current" : ""} />
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
      )}

      {previewFile && (
        <FilePreviewModal file={previewFile} onClose={() => setPreviewFile(null)} />
      )}
      {shareFile && (
        <ShareModal file={shareFile} onClose={() => setShareFile(null)} />
      )}
    </div>
  );
}
