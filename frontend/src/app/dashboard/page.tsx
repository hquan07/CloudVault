'use client';

import { useState, useEffect, useRef } from 'react';
import { Upload, FolderOpen, File as FileIcon, Download, Trash2, CloudUpload, Share2, Star, ChevronLeft, Plus, UploadCloud, Users, Image as ImageIcon, Video, FileText, Music, FileArchive, LayoutGrid, List } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { metaApi, fileApi } from '@/lib/api';
import { formatBytes, formatRelative, getFileIcon } from '@/lib/utils';
import { useAuth } from '@/lib/auth-context';
import { FilePreviewModal } from '@/components/FilePreviewModal';
import { ShareModal } from '@/components/ShareModal';
import { ShareFolderModal } from '@/components/ShareFolderModal';

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

export interface FolderItem {
  id: string;
  name: string;
  parent_id: string | null;
  path: string;
  depth: number;
  created_at: string;
}

const FileIconDisplay = ({ mimeType, size = 24 }: { mimeType: string, size?: number }) => {
  const iconType = getFileIcon(mimeType);
  switch (iconType) {
    case 'image': return <ImageIcon size={size} className="text-blue-400" />;
    case 'video': return <Video size={size} className="text-purple-400" />;
    case 'audio': return <Music size={size} className="text-yellow-400" />;
    case 'pdf': return <FileText size={size} className="text-red-400" />;
    case 'archive': return <FileArchive size={size} className="text-orange-400" />;
    default: return <FileIcon size={size} className="text-cyan-400" />;
  }
};

const SkeletonCard = () => (
  <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 animate-pulse flex flex-col h-full">
    <div className="w-12 h-12 rounded-xl bg-gray-800 mb-4"></div>
    <div className="h-4 bg-gray-800 rounded w-3/4 mb-2"></div>
    <div className="flex justify-between mt-auto">
      <div className="h-3 bg-gray-800 rounded w-1/3"></div>
      <div className="h-3 bg-gray-800 rounded w-1/4"></div>
    </div>
  </div>
);

export default function DrivePage() {
  const { refreshUser } = useAuth();
  const [files, setFiles] = useState<FileItem[]>([]);
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [folderPath, setFolderPath] = useState<{id: string, name: string}[]>([]);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<'idle' | 'uploading' | 'success'>('idle');
  const [error, setError] = useState('');
  const [previewFile, setPreviewFile] = useState<FileItem | null>(null);
  const [shareFile, setShareFile] = useState<FileItem | null>(null);
  const [shareFolder, setShareFolder] = useState<FolderItem | null>(null);

  // Drag & Drop / Dropdown states
  const [isDragActive, setIsDragActive] = useState(false);
  const [isUploadMenuOpen, setIsUploadMenuOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; item: FileItem | FolderItem; type: 'file' | 'folder' } | null>(null);

  const handleContextMenu = (e: React.MouseEvent, item: FileItem | FolderItem, type: 'file' | 'folder') => {
    e.preventDefault();
    e.stopPropagation();
    console.log('Context menu triggered!', e.clientX, e.clientY, type, item);
    setContextMenu({ x: e.clientX, y: e.clientY, item, type });
  };

  useEffect(() => {
    const handleClick = () => setContextMenu(null);
    const handleScroll = () => setContextMenu(null);
    window.addEventListener('click', handleClick);
    window.addEventListener('contextmenu', handleClick);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      window.removeEventListener('click', handleClick);
      window.removeEventListener('contextmenu', handleClick);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, []);

  useEffect(() => {
    let dragCounter = 0;
    const handleDragEnter = (e: DragEvent) => {
      e.preventDefault();
      dragCounter++;
      if (e.dataTransfer?.items && e.dataTransfer.items.length > 0) {
        setIsDragActive(true);
      }
    };
    const handleDragLeave = (e: DragEvent) => {
      e.preventDefault();
      dragCounter--;
      if (dragCounter === 0) {
        setIsDragActive(false);
      }
    };
    const handleDragOver = (e: DragEvent) => {
      e.preventDefault();
    };
    const handleDrop = (e: DragEvent) => {
      e.preventDefault();
      dragCounter = 0;
      setIsDragActive(false);
      if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        processFiles(Array.from(e.dataTransfer.files));
      }
    };

    window.addEventListener('dragenter', handleDragEnter);
    window.addEventListener('dragleave', handleDragLeave);
    window.addEventListener('dragover', handleDragOver);
    window.addEventListener('drop', handleDrop);

    return () => {
      window.removeEventListener('dragenter', handleDragEnter);
      window.removeEventListener('dragleave', handleDragLeave);
      window.removeEventListener('dragover', handleDragOver);
      window.removeEventListener('drop', handleDrop);
    };
  }, [currentFolderId]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsUploadMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const loadFiles = async () => {
    setLoading(true);
    try {
      const data = await metaApi.listFiles({ 
        sort_by: 'created_at', 
        sort_order: 'desc',
        folder_id: currentFolderId || 'root'
      }) as { files: FileItem[], folders: FolderItem[] };
      setFiles(data.files || []);
      setFolders(data.folders || []);
    } catch (err: any) {
      setError(err.message || 'Failed to load files');
    }
    setLoading(false);
  };

  useEffect(() => {
    loadFiles();
  }, [currentFolderId]);

  const processFiles = async (filesArray: File[]) => {
    if (filesArray.length === 0) return;
    
    setUploading(true);
    setUploadStatus('uploading');
    setError('');
    
    try {
      for (const file of filesArray) {
        const relativePath = (file as any).customRelativePath || file.webkitRelativePath || undefined;
        await fileApi.upload(file, currentFolderId || undefined, relativePath);
      }
      await loadFiles();
      refreshUser();
      setUploadStatus('success');
      setTimeout(() => {
        setUploading(false);
        setUploadStatus('idle');
      }, 3000);
    } catch (err: any) {
      setError(err.message || 'Upload failed');
      setUploading(false);
      setUploadStatus('idle');
    }
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;
    await processFiles(Array.from(e.target.files));
    e.target.value = ''; // Reset input
    setIsUploadMenuOpen(false);
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

  const handleNavigate = (folder: FolderItem) => {
    setCurrentFolderId(folder.id);
    setFolderPath([...folderPath, { id: folder.id, name: folder.name }]);
  };

  const handleNavigateUp = () => {
    const newPath = [...folderPath];
    newPath.pop();
    setFolderPath(newPath);
    setCurrentFolderId(newPath.length > 0 ? newPath[newPath.length - 1].id : null);
  };

  // Drag & Drop Handlers
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragActive(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    // Prevent flickering when dragging over child elements
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsDragActive(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragActive(false);
    
    const items = e.dataTransfer.items;
    if (!items) return;

    const filesToUpload: File[] = [];

    const readDirectory = async (dirEntry: any, path: string = '') => {
      const dirReader = dirEntry.createReader();
      const entries = await new Promise<any[]>((resolve) => {
        dirReader.readEntries((results: any[]) => resolve(results));
      });

      for (const entry of entries) {
        if (entry.isFile) {
          const file = await new Promise<File>((resolve) => entry.file(resolve));
          (file as any).customRelativePath = `${path}${entry.name}`;
          filesToUpload.push(file);
        } else if (entry.isDirectory) {
          await readDirectory(entry, `${path}${entry.name}/`);
        }
      }
    };

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file') {
        const entry = item.webkitGetAsEntry();
        if (entry) {
          if (entry.isFile) {
            const file = await new Promise<File>((resolve) => (entry as any).file(resolve));
            filesToUpload.push(file);
          } else if (entry.isDirectory) {
            await readDirectory(entry, `${entry.name}/`);
          }
        }
      }
    }

    if (filesToUpload.length > 0) {
      await processFiles(filesToUpload);
    }
  };

  return (
    <div 
      className="space-y-6 relative min-h-[80vh] w-full"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Smart Drag & Drop Overlay */}
      {isDragActive && (
        <div className="absolute inset-0 z-50 bg-cyan-950/40 backdrop-blur-sm border-2 border-dashed border-cyan-500 rounded-3xl flex flex-col items-center justify-center transition-all">
          <div className="w-24 h-24 bg-gray-900 rounded-full flex items-center justify-center mb-6 shadow-2xl shadow-cyan-900/50">
            <UploadCloud size={48} className="text-cyan-400 animate-bounce" />
          </div>
          <h2 className="text-3xl font-bold text-white mb-2">Drop to Upload</h2>
          <p className="text-cyan-200 text-lg">Release files or folders to securely store them.</p>
        </div>
      )}

      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            {currentFolderId && (
              <button onClick={handleNavigateUp} className="p-1 hover:bg-gray-800 rounded-lg text-gray-400 hover:text-white transition-colors">
                <ChevronLeft size={24} />
              </button>
            )}
            {currentFolderId ? folderPath[folderPath.length - 1]?.name : 'My Files'}
          </h1>
          {folderPath.length > 0 && (
            <div className="text-sm text-gray-500 mt-1">
              Home {folderPath.map(f => ` / ${f.name}`)}
            </div>
          )}
        </div>
        
        {/* Unified Upload Dropdown & View Toggle */}
        <div className="flex items-center gap-3 relative" ref={dropdownRef}>
          <div className="flex items-center bg-gray-900 border border-gray-800 rounded-xl p-1">
            <button 
              onClick={() => setViewMode('grid')}
              className={`p-1.5 rounded-lg transition-colors ${viewMode === 'grid' ? 'bg-cyan-500/20 text-cyan-400' : 'text-gray-500 hover:text-gray-300'}`}
            >
              <LayoutGrid size={18} />
            </button>
            <button 
              onClick={() => setViewMode('list')}
              className={`p-1.5 rounded-lg transition-colors ${viewMode === 'list' ? 'bg-cyan-500/20 text-cyan-400' : 'text-gray-500 hover:text-gray-300'}`}
            >
              <List size={18} />
            </button>
          </div>

          <button 
            onClick={() => setIsUploadMenuOpen(!isUploadMenuOpen)}
            disabled={uploading}
            className="flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500 disabled:opacity-50 text-white font-medium rounded-xl transition-all shadow-lg shadow-blue-900/20"
          >
            {uploading ? <CloudUpload className="animate-bounce" size={20} /> : <Plus size={20} />}
            {uploading ? 'Uploading...' : 'New'}
          </button>

          {isUploadMenuOpen && !uploading && (
            <div className="absolute top-full mt-2 right-0 w-48 bg-gray-900 border border-gray-700 rounded-xl shadow-xl overflow-hidden z-50 py-1">
              <label className="flex items-center gap-3 px-4 py-3 hover:bg-gray-800 cursor-pointer text-gray-200 transition-colors">
                <FileIcon size={18} className="text-cyan-400" />
                <span>Upload Files</span>
                <input 
                  type="file" 
                  className="hidden" 
                  onChange={handleUpload}
                  multiple
                />
              </label>
              <label className="flex items-center gap-3 px-4 py-3 hover:bg-gray-800 cursor-pointer text-gray-200 transition-colors">
                <FolderOpen size={18} className="text-purple-400" />
                <span>Upload Folder</span>
                <input 
                  type="file" 
                  // @ts-expect-error Non-standard directory upload attribute supported by Chromium.
                  webkitdirectory="true"
                  directory="true"
                  multiple
                  className="hidden" 
                  onChange={handleUpload}
                />
              </label>
            </div>
          )}
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded-xl text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {[...Array(8)].map((_, i) => <SkeletonCard key={i} />)}
        </div>
      ) : files.length === 0 && folders.length === 0 ? (
        <div className="text-center py-24 px-8 border-2 border-dashed border-gray-800 rounded-3xl bg-gray-900/30">
          <div className="w-32 h-32 mx-auto mb-6 text-gray-700 flex items-center justify-center relative">
            {/* Cute Empty Cloud SVG */}
            <svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" className="w-full h-full opacity-60">
              <path d="M 60,110 C 60,85 80,65 105,65 C 110,65 115,66 120,68 C 128,50 148,40 165,50 C 180,60 185,80 180,95 C 190,98 198,105 198,115 C 198,130 185,145 170,145 L 60,145 C 40,145 25,130 25,110 C 25,95 35,80 50,75 C 55,75 60,80 60,110 Z" fill="currentColor" />
              {/* Sleeping Eyes */}
              <path d="M 85,110 Q 95,120 105,110" fill="none" stroke="#4b5563" strokeWidth="3" strokeLinecap="round" />
              <path d="M 125,110 Q 135,120 145,110" fill="none" stroke="#4b5563" strokeWidth="3" strokeLinecap="round" />
              {/* Zzz */}
              <text x="145" y="70" fontSize="20" fill="#4b5563" fontWeight="bold">Z</text>
              <text x="165" y="55" fontSize="16" fill="#4b5563" fontWeight="bold">z</text>
              <text x="180" y="45" fontSize="12" fill="#4b5563" fontWeight="bold">z</text>
            </svg>
          </div>
          <h3 className="text-xl font-medium text-gray-200 mb-2">So empty in here...</h3>
          <p className="text-gray-500 max-w-sm mx-auto mb-6">The cloud is sleeping. Drag and drop files or folders here to wake it up!</p>
        </div>
      ) : (
        <AnimatePresence mode="wait">
          <motion.div 
            key={viewMode}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.15 }}
            className={viewMode === 'grid' ? "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4" : "flex flex-col gap-2"}
          >
            <AnimatePresence>
            {folders.map(folder => (
              <motion.div 
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                layout
                key={folder.id} 
                className={`group bg-gray-900 border border-gray-700 p-5 hover:border-cyan-500/50 transition-all hover:shadow-lg hover:shadow-cyan-900/10 cursor-pointer flex items-center gap-4 ${viewMode === 'grid' ? 'rounded-2xl' : 'rounded-xl'}`}
              onClick={() => handleNavigate(folder)}
              onContextMenu={(e) => handleContextMenu(e, folder, 'folder')}
            >
              <div className="w-10 h-10 rounded-xl bg-gray-800 flex items-center justify-center text-yellow-500 shrink-0">
                <FolderOpen size={20} className="fill-current opacity-80" />
              </div>
              <h4 className="font-medium text-gray-200 truncate flex-1" title={folder.name}>
                {folder.name}
              </h4>
              {viewMode === 'list' && (
                <div className="text-xs text-gray-500 hidden sm:block w-32 shrink-0">{formatRelative(folder.created_at)}</div>
              )}
              <button 
                onClick={(e) => { e.stopPropagation(); setShareFolder(folder); }}
                className={`p-2 text-gray-500 hover:text-cyan-400 hover:bg-cyan-400/10 rounded-lg transition-all ${viewMode === 'list' ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                title="Share folder"
              >
                <Users size={18} />
              </button>
            </motion.div>
          ))}

          {files.map(file => (
            <motion.div 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9 }}
              layout
              key={file.id} 
              className={`group bg-gray-900 border border-gray-800 p-5 hover:border-cyan-500/30 transition-all hover:shadow-lg hover:shadow-cyan-900/10 cursor-pointer flex ${viewMode === 'grid' ? 'rounded-2xl flex-col h-full' : 'rounded-xl flex-row items-center gap-4'}`}
              onClick={() => setPreviewFile(file)}
              onContextMenu={(e) => handleContextMenu(e, file, 'file')}
            >
              <div className={`flex items-start justify-between ${viewMode === 'grid' ? 'mb-4' : 'flex-1 items-center gap-4'}`}>
                <div className={`rounded-xl bg-gray-800 flex items-center justify-center shrink-0 ${viewMode === 'grid' ? 'w-12 h-12' : 'w-10 h-10'}`}>
                  <FileIconDisplay mimeType={file.mime_type} size={viewMode === 'grid' ? 24 : 20} />
                </div>
                
                {viewMode === 'list' && (
                  <div className="flex-1 min-w-0">
                    <h4 className="font-medium text-gray-200 truncate" title={file.filename}>{file.filename}</h4>
                  </div>
                )}
                {viewMode === 'list' && (
                  <div className="text-xs text-gray-500 hidden md:block w-24 shrink-0">{formatBytes(file.size)}</div>
                )}
                {viewMode === 'list' && (
                  <div className="text-xs text-gray-500 hidden sm:block w-32 shrink-0">{formatRelative(file.created_at)}</div>
                )}

                <div className={`flex space-x-1 transition-opacity ${viewMode === 'list' ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
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
              
              {viewMode === 'grid' && (
                <>
                  <h4 className="font-medium text-gray-200 truncate mb-1" title={file.original_name}>
                    {file.original_name}
                  </h4>
                  <div className="flex items-center justify-between text-xs text-gray-500 mt-auto pt-4">
                    <span>{formatBytes(file.size)}</span>
                    <span>{file.created_at ? formatRelative(file.created_at) : 'Unknown date'}</span>
                  </div>
                </>
              )}
            </motion.div>
          ))}
          </AnimatePresence>
        </motion.div>
        </AnimatePresence>
      )}

      {previewFile && (
        <FilePreviewModal file={previewFile} onClose={() => setPreviewFile(null)} />
      )}
      {shareFile && (
        <ShareModal file={shareFile} onClose={() => setShareFile(null)} />
      )}
      {shareFolder && (
        <ShareFolderModal folder={shareFolder} onClose={() => setShareFolder(null)} />
      )}

      {/* Context Menu */}
      {contextMenu && (
        <div 
          className="fixed z-[1000] bg-gray-900 border border-gray-700 rounded-xl shadow-2xl overflow-hidden min-w-[160px] py-1"
          style={{ top: `${contextMenu.y}px`, left: `${contextMenu.x}px` }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.type === 'file' ? (
            <>
              <button 
                className="w-full text-left px-4 py-2 text-sm text-gray-200 hover:bg-cyan-500/20 hover:text-cyan-400 flex items-center gap-2"
                onClick={() => { setPreviewFile(contextMenu.item as FileItem); setContextMenu(null); }}
              ><FileIcon size={16} /> Open</button>
              <button 
                className="w-full text-left px-4 py-2 text-sm text-gray-200 hover:bg-cyan-500/20 hover:text-cyan-400 flex items-center gap-2"
                onClick={() => { handleDownload(contextMenu.item.id); setContextMenu(null); }}
              ><Download size={16} /> Download</button>
              <button 
                className="w-full text-left px-4 py-2 text-sm text-gray-200 hover:bg-cyan-500/20 hover:text-cyan-400 flex items-center gap-2"
                onClick={() => { setShareFile(contextMenu.item as FileItem); setContextMenu(null); }}
              ><Share2 size={16} /> Share</button>
              <div className="h-px bg-gray-800 my-1"></div>
              <button 
                className="w-full text-left px-4 py-2 text-sm text-red-400 hover:bg-red-500/20 flex items-center gap-2"
                onClick={() => { handleDelete(contextMenu.item.id); setContextMenu(null); }}
              ><Trash2 size={16} /> Move to Trash</button>
            </>
          ) : (
            <>
              <button 
                className="w-full text-left px-4 py-2 text-sm text-gray-200 hover:bg-cyan-500/20 hover:text-cyan-400 flex items-center gap-2"
                onClick={() => { handleNavigate(contextMenu.item as FolderItem); setContextMenu(null); }}
              ><FolderOpen size={16} /> Open Folder</button>
              <button 
                className="w-full text-left px-4 py-2 text-sm text-gray-200 hover:bg-cyan-500/20 hover:text-cyan-400 flex items-center gap-2"
                onClick={() => { setShareFolder(contextMenu.item as FolderItem); setContextMenu(null); }}
              ><Users size={16} /> Share Folder</button>
            </>
          )}
        </div>
      )}

      {/* Drag overlay */}
      <AnimatePresence>
        {isDragActive && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] bg-cyan-900/40 backdrop-blur-sm flex flex-col items-center justify-center border-4 border-cyan-400 border-dashed m-4 rounded-3xl pointer-events-none"
          >
            <div className="bg-gray-900 rounded-full p-6 mb-4 shadow-2xl">
              <CloudUpload size={48} className="text-cyan-400 animate-bounce" />
            </div>
            <h2 className="text-3xl font-bold text-white drop-shadow-lg">Drop files here to upload</h2>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Upload Progress Panel */}
      <AnimatePresence>
        {uploading && (
          <motion.div 
            initial={{ opacity: 0, y: 50, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 50, scale: 0.9 }}
            className="fixed bottom-6 right-6 z-40 bg-gray-900 border border-gray-700 shadow-2xl rounded-xl p-4 min-w-[300px]"
          >
            <div className="flex items-center gap-3 mb-2">
              {uploadStatus === 'uploading' ? (
                <>
                  <div className="animate-spin w-4 h-4 border-2 border-cyan-400 border-t-transparent rounded-full"></div>
                  <h4 className="text-white font-medium">Uploading files...</h4>
                </>
              ) : (
                <>
                  <div className="w-4 h-4 rounded-full bg-green-500 flex items-center justify-center text-white text-[10px]">✓</div>
                  <h4 className="text-green-400 font-medium">Upload complete!</h4>
                </>
              )}
            </div>
            <div className="h-1.5 w-full bg-gray-800 rounded-full overflow-hidden">
              <motion.div 
                className={`h-full rounded-full ${uploadStatus === 'success' ? 'bg-green-500' : 'bg-cyan-400'}`}
                initial={{ width: "0%" }}
                animate={{ width: uploadStatus === 'success' ? "100%" : "85%" }} 
                transition={{ duration: uploadStatus === 'success' ? 0.3 : 10, ease: "easeOut" }}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
