'use client';

import { useState, useEffect } from 'react';
import { Trash2, RotateCcw, AlertTriangle, File as FileIcon } from 'lucide-react';
import { fileApi } from '@/lib/api';
import { formatBytes, formatRelative } from '@/lib/utils';
import { FilePreviewModal } from '@/components/FilePreviewModal';
import { FileItem } from '@/app/dashboard/page';

export default function TrashPage() {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [previewFile, setPreviewFile] = useState<FileItem | null>(null);

  const loadFiles = async () => {
    setLoading(true);
    try {
      const data = await fileApi.getTrash() as any;
      setFiles(Array.isArray(data) ? data : (data.files || []));
    } catch { /* silent */ }
    setLoading(false);
  };

  useEffect(() => {
    loadFiles();
  }, []);

  const handleRestore = async (id: string) => {
    try {
      await fileApi.restore(id);
    } catch (err) {
      console.error('Restore error:', err);
    } finally {
      loadFiles();
    }
  };

  const handlePermanentDelete = async (id: string) => {
    try {
      await fileApi.permanentDelete(id);
    } catch (err) {
      console.error('Permanent delete error:', err);
    } finally {
      loadFiles();
    }
  };

  const handleEmptyTrash = async () => {
    try {
      await Promise.allSettled(files.map(f => fileApi.permanentDelete(f.id)));
    } catch (err) {
      console.error('Empty trash error:', err);
    } finally {
      loadFiles();
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-bold flex items-center gap-3">
            <Trash2 className="text-red-500" size={28} /> Trash
          </h1>
          <span className="text-gray-500 hidden sm:inline">Deleted files</span>
        </div>
        
        {files.length > 0 && (
          <button 
            onClick={handleEmptyTrash} 
            className="flex items-center gap-2 px-4 py-2 bg-red-500/10 hover:bg-red-500/20 text-red-500 border border-red-500/30 rounded-xl font-medium transition-all"
          >
            <Trash2 size={18} /> Clear Trash
          </button>
        )}
      </div>
      
      {loading ? (
        <div className="p-12 text-center text-gray-500">Loading trash...</div>
      ) : files.length === 0 ? (
        <div className="text-center py-24 px-8 border-2 border-dashed border-gray-800 rounded-2xl bg-gray-900/30">
          <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-red-500/10 flex items-center justify-center text-red-500">
            <Trash2 size={32} />
          </div>
          <h3 className="text-xl font-medium text-gray-200 mb-2">Trash is empty</h3>
          <p className="text-gray-500 max-w-sm mx-auto mb-6">Deleted files will be stored here for 30 days before permanent removal.</p>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-3 p-4 bg-yellow-500/10 border border-yellow-500/20 text-yellow-500 rounded-xl">
            <AlertTriangle size={20} className="shrink-0" />
            <span className="text-sm">Files in trash will be automatically deleted after 30 days.</span>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {files.map(file => (
              <div 
                key={file.id} 
                className="group bg-gray-900 border border-red-500/20 rounded-2xl p-5 hover:border-red-500/50 transition-all hover:shadow-lg hover:shadow-red-900/10 cursor-pointer"
                onClick={() => setPreviewFile(file)}
              >
                <div className="flex items-start justify-between mb-4">
                  <div className="w-12 h-12 rounded-xl bg-red-500/10 flex items-center justify-center text-red-500/70">
                    <FileIcon size={24} />
                  </div>
                  <div className="flex space-x-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button 
                      onClick={(e) => { e.stopPropagation(); handleRestore(file.id); }} 
                      className="p-2 text-cyan-400 hover:bg-gray-800 rounded-lg transition-colors"
                      title="Restore"
                    >
                      <RotateCcw size={18} />
                    </button>
                    <button 
                      onClick={(e) => { e.stopPropagation(); handlePermanentDelete(file.id); }} 
                      className="p-2 text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
                      title="Delete forever"
                    >
                      <Trash2 size={18} />
                    </button>
                  </div>
                </div>
                
                <h4 className="font-medium text-gray-200 truncate mb-1 opacity-60 line-through" title={file.original_name}>
                  {file.original_name}
                </h4>
                
                <div className="flex items-center justify-between text-xs text-gray-600">
                  <span>{formatBytes(file.size)}</span>
                  <span>{file.deleted_at ? formatRelative(file.deleted_at) : ''}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {previewFile && (
        <FilePreviewModal file={previewFile} onClose={() => setPreviewFile(null)} />
      )}
    </div>
  );
}
