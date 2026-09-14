'use client';

import { useState, useEffect } from 'react';
import { Upload, FolderOpen, File as FileIcon, Download, Trash2, CloudUpload, Share2, Star } from 'lucide-react';
import { metaApi, fileApi } from '@/lib/api';
import { formatBytes, formatRelative, getFileIcon } from '@/lib/utils';
import { useAuth } from '@/lib/auth-context';
import { FilePreviewModal } from '@/components/FilePreviewModal';
import { ShareModal } from '@/components/ShareModal';

export interface FileItem {
  id: string;
  filename: string;
  original_name: string;
  mime_type: string;
  size: number;
  thumbnail_url: string | null;
  created_at: string;
  updated_at: string;
  is_deleted: boolean;
  deleted_at?: string;
  is_starred?: boolean;
}

export default function DrivePage() {
  const { refreshUser } = useAuth();
  const [files, setFiles] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [previewFile, setPreviewFile] = useState<FileItem | null>(null);
  const [shareFile, setShareFile] = useState<FileItem | null>(null);

  const loadFiles = async () => {
    setLoading(true);
    try {
      const data = await metaApi.listFiles({ sort_by: 'created_at', sort_order: 'desc' }) as { files: FileItem[] };
      setFiles(data.files || []);
    } catch (err: any) {
      setError(err.message || 'Failed to load files');
    }
    setLoading(false);
  };

  useEffect(() => {
    loadFiles();
  }, []);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    const file = e.target.files[0];
    
    setUploading(true);
    setError('');
    
    try {
      await fileApi.upload(file);
      await loadFiles();
      refreshUser();
    } catch (err: any) {
      setError(err.message || 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const handleDownload = async (fileId: string) => {
    try {
      const data = await fileApi.download(fileId);
      if (data.download_url) {
        window.location.href = data.download_url;
      }
    } catch (err: any) {
      setError(err.message || 'Download failed');
    }
  };

  const handleDelete = async (fileId: string) => {
    if (!confirm('Move this file to trash?')) return;
    try {
      await fileApi.deleteFile(fileId);
      setFiles(files.filter(f => f.id !== fileId));
      refreshUser();
    } catch (err: any) {
      setError(err.message || 'Delete failed');
    }
  };

  const handleToggleStar = async (fileId: string, currentStatus: boolean) => {
    try {
      await metaApi.updateFile(fileId, { is_starred: !currentStatus });
      setFiles(files.map(f => f.id === fileId ? { ...f, is_starred: !currentStatus } : f));
    } catch (err: any) {
      setError(err.message || 'Failed to update star status');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <h1 className="text-2xl font-bold">My Files</h1>
        
        <div className="relative">
          <input 
            type="file" 
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" 
            onChange={handleUpload}
            disabled={uploading}
          />
          <button 
            disabled={uploading}
            className="flex items-center gap-2 px-5 py-2.5 bg-cyan-600 hover:bg-cyan-500 disabled:bg-cyan-800 disabled:cursor-not-allowed text-white font-medium rounded-xl transition-colors shadow-lg shadow-cyan-900/20"
          >
            {uploading ? <CloudUpload className="animate-bounce" size={20} /> : <Upload size={20} />}
            {uploading ? 'Uploading...' : 'Upload File'}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded-xl text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <div className="p-12 text-center text-gray-500">Loading your files...</div>
      ) : files.length === 0 ? (
        <div className="text-center py-24 px-8 border-2 border-dashed border-gray-800 rounded-2xl bg-gray-900/30">
          <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-gray-800 flex items-center justify-center text-gray-400">
            <FolderOpen size={32} />
          </div>
          <h3 className="text-xl font-medium text-gray-200 mb-2">Your vault is empty</h3>
          <p className="text-gray-500 max-w-sm mx-auto mb-6">Upload files to securely store them in the cloud. They will appear here.</p>
          <div className="relative inline-block">
            <input 
              type="file" 
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" 
              onChange={handleUpload}
            />
            <button className="px-6 py-2.5 bg-gray-800 hover:bg-gray-700 text-white font-medium rounded-xl transition-colors">
              Browse Files
            </button>
          </div>
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
                  <button 
                    onClick={(e) => { e.stopPropagation(); handleDelete(file.id); }}
                    className="p-2 text-gray-400 hover:text-red-400 hover:bg-gray-800 rounded-lg transition-colors"
                  >
                    <Trash2 size={18} />
                  </button>
                </div>
              </div>
              
              <h4 className="font-medium text-gray-200 truncate mb-1" title={file.original_name}>
                {file.original_name}
              </h4>
              <div className="flex items-center justify-between text-xs text-gray-500">
                <span>{formatBytes(file.size)}</span>
                <span>{formatRelative(file.created_at)}</span>
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