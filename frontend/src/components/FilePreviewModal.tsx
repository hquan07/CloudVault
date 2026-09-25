'use client';

import { X, Download, AlertCircle, Loader2, FileIcon, History, RotateCcw, Maximize2, Minimize2, Info, ChevronLeft, ChevronRight } from 'lucide-react';
import { useState, useEffect } from 'react';
import dynamic from 'next/dynamic';
import { fileApi, metaApi } from '@/lib/api';
import { formatBytes, formatRelative } from '@/lib/utils';

const ReactPlayer = dynamic(() => import('react-player'), { ssr: false }) as any;

export interface FileItem {
  id: string;
  filename?: string;
  original_name: string;
  mime_type: string;
  size: number;
  created_at?: string;
  updated_at?: string;
  checksum_sha256?: string;
  current_version?: number;
}

interface Props {
  file: FileItem;
  onClose: () => void;
  siblings?: FileItem[];
  onSelect?: (file: FileItem) => void;
  onChanged?: () => void;
}

export function FilePreviewModal({ file, onClose, siblings = [], onSelect, onChanged }: Props) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showVersions, setShowVersions] = useState(false);
  const [versions, setVersions] = useState<any[]>([]);
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [restoringVersion, setRestoringVersion] = useState<number | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<FileItem>(file);
  const [showInfo, setShowInfo] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    const fetchUrl = async () => {
      try {
        const data = await fileApi.download(file.id);
        if (data.download_url) {
          setUrl(data.download_url);
          // If text file, fetch content to display directly
          if (file.mime_type?.startsWith('text/') || file.mime_type === 'application/json' || file.mime_type === 'application/xml') {
            try {
              const res = await fetch(data.download_url);
              const text = await res.text();
              setTextContent(text);
            } catch (err) {
              console.error("Failed to fetch text content", err);
            }
          }
        } else {
          setError('Could not generate preview URL');
        }
      } catch (err: any) {
        setError(err.message || 'Failed to load preview');
      } finally {
        setLoading(false);
      }
    };
    setLoading(true); setUrl(null); setTextContent(null); setError(''); setMetadata(file);
    fetchUrl();
    metaApi.getFile(file.id).then(data => setMetadata(data as FileItem)).catch(() => undefined);
  }, [file.id]);

  useEffect(() => {
    if (showVersions && versions.length === 0) {
      const fetchVersions = async () => {
        setLoadingVersions(true);
        try {
          const data = await fileApi.getVersions(file.id);
          setVersions(data || []);
        } catch (err) {
          console.error("Failed to fetch versions", err);
        } finally {
          setLoadingVersions(false);
        }
      };
      fetchVersions();
    }
  }, [showVersions, file.id, versions.length]);

  const handleRestore = async (versionNumber: number) => {
    setRestoringVersion(versionNumber);
    try {
      await fileApi.restoreVersion(file.id, versionNumber);
      setVersions([]);
      setShowVersions(false);
      onChanged?.();
    } catch (err) {
      console.error("Failed to restore", err);
      alert("Failed to restore version");
    } finally {
      setRestoringVersion(null);
    }
  };

  const type = (file.mime_type || '').toLowerCase();
  const isImage = type.startsWith('image/');
  const isVideo = type.startsWith('video/');
  const isAudio = type.startsWith('audio/');
  const isPdf = type === 'application/pdf';
  const isText = type.startsWith('text/') || type === 'application/json' || type === 'application/xml';
  
  const canPreview = isImage || isVideo || isAudio || isPdf || isText;

  // Prevent background scrolling when modal is open
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = 'unset';
    };
  }, []);

  const currentIndex = siblings.findIndex(item => item.id === file.id);
  const navigate = (direction: number) => {
    if (!onSelect || currentIndex < 0) return;
    const next = siblings[currentIndex + direction];
    if (next) onSelect(next);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowLeft') navigate(-1);
      if (event.key === 'ArrowRight') navigate(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [currentIndex, siblings, onSelect, onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 animate-in fade-in duration-200">
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={onClose} />
      <div className={`relative w-full bg-gray-900 border border-gray-800 shadow-2xl flex flex-col overflow-hidden animate-in zoom-in-95 duration-200 ${fullscreen ? 'h-full max-w-none rounded-none' : 'max-w-6xl h-[88vh] rounded-2xl'}`}>
        
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-800 bg-gray-900/50 backdrop-blur-md">
          <div className="flex items-center gap-3 overflow-hidden">
            <h3 className="font-medium text-gray-200 truncate" title={file.original_name}>
              {file.original_name}
            </h3>
            <span className="text-xs text-gray-500 px-2 py-1 bg-gray-800 rounded-md shrink-0">
              {formatBytes(file.size)}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0 ml-4">
            <button 
              onClick={() => setShowVersions(!showVersions)}
              className={`p-2 rounded-lg transition-colors ${showVersions ? 'bg-cyan-900/50 text-cyan-400' : 'text-gray-400 hover:text-cyan-400 hover:bg-gray-800'}`}
              title="Version History"
            >
              <History size={20} />
            </button>
            <button onClick={() => setShowInfo(!showInfo)} className={`p-2 rounded-lg ${showInfo ? 'bg-cyan-900/50 text-cyan-400' : 'text-gray-400 hover:bg-gray-800'}`} title="File details"><Info size={20} /></button>
            <button onClick={() => setFullscreen(!fullscreen)} className="p-2 text-gray-400 hover:bg-gray-800 rounded-lg" title="Toggle fullscreen">{fullscreen ? <Minimize2 size={20} /> : <Maximize2 size={20} />}</button>
            {url && (
              <a 
                href={url} 
                download={file.original_name}
                className="p-2 text-gray-400 hover:text-cyan-400 hover:bg-gray-800 rounded-lg transition-colors"
                title="Download file"
              >
                <Download size={20} />
              </a>
            )}
            <button 
              onClick={onClose}
              className="p-2 text-gray-400 hover:text-red-400 hover:bg-gray-800 rounded-lg transition-colors"
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Content & Sidebar Wrapper */}
        <div className="flex-1 flex overflow-hidden">
          {/* Main Content */}
          <div className="flex-1 overflow-hidden bg-black/40 flex items-center justify-center p-4 relative">
          {currentIndex > 0 && <button onClick={() => navigate(-1)} className="absolute left-3 top-1/2 z-10 rounded-full bg-gray-900/80 p-2 text-gray-300 hover:text-white"><ChevronLeft /></button>}
          {currentIndex >= 0 && currentIndex < siblings.length - 1 && <button onClick={() => navigate(1)} className="absolute right-3 top-1/2 z-10 rounded-full bg-gray-900/80 p-2 text-gray-300 hover:text-white"><ChevronRight /></button>}
          {loading ? (
            <div className="flex flex-col items-center text-gray-500">
              <Loader2 className="animate-spin mb-3 text-cyan-500" size={32} />
              <p>Loading preview...</p>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center text-red-400 max-w-md text-center">
              <AlertCircle size={48} className="mb-4 opacity-50" />
              <p className="mb-2 font-medium">Failed to load preview</p>
              <p className="text-sm opacity-80">{error}</p>
            </div>
          ) : !canPreview ? (
            <div className="flex flex-col items-center text-gray-400 max-w-md text-center">
              <div className="w-20 h-20 bg-gray-800 rounded-2xl flex items-center justify-center mb-6">
                <FileIcon size={32} />
              </div>
              <h3 className="text-xl text-gray-200 font-medium mb-2">Preview not available</h3>
              <p className="text-sm mb-6 text-gray-500">
                No preview is available for {file.mime_type || 'this file type'}.
              </p>
              <a 
                href={url!} 
                download={file.original_name}
                className="flex items-center gap-2 px-6 py-2.5 bg-cyan-600 hover:bg-cyan-500 text-white font-medium rounded-xl transition-colors shadow-lg shadow-cyan-900/20"
              >
                <Download size={18} /> Download File
              </a>
            </div>
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              {isImage && (
                <img src={url!} alt={file.original_name} className="max-w-full max-h-full object-contain rounded-lg" />
              )}
              {isVideo && (
                <div className="w-full h-full flex items-center justify-center rounded-lg shadow-lg bg-black overflow-hidden">
                  <ReactPlayer 
                    url={url!} 
                    controls 
                    playing 
                    width="100%" 
                    height="100%" 
                    style={{ maxWidth: '100%', maxHeight: '100%' }}
                  />
                </div>
              )}
              {isAudio && (
                <div className="w-full max-w-md bg-gray-800 p-6 rounded-2xl shadow-xl flex flex-col items-center">
                  <div className="w-24 h-24 bg-cyan-900/30 text-cyan-400 rounded-full flex items-center justify-center mb-6">
                    <FileIcon size={40} />
                  </div>
                  <h4 className="text-gray-200 font-medium text-lg mb-4 text-center truncate w-full">{file.original_name}</h4>
                  <audio src={url!} controls autoPlay className="w-full mt-4" />
                </div>
              )}
              {isPdf && (
                <iframe src={url!} className="w-full h-full rounded-lg bg-white" title={file.original_name} />
              )}
              {isText && textContent !== null && (
                <div className="w-full h-full bg-[#1e1e1e] text-[#d4d4d4] p-6 rounded-lg overflow-auto font-mono text-sm shadow-inner text-left whitespace-pre-wrap">
                  {textContent}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Versions Sidebar */}
        {showVersions && (
          <div className="w-80 border-l border-gray-800 bg-gray-900 flex flex-col animate-in slide-in-from-right-8 duration-200">
            <div className="p-4 border-b border-gray-800">
              <h4 className="font-medium text-gray-200">Version History</h4>
              <p className="text-xs text-gray-500 mt-1">Restore previous versions of this file.</p>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {loadingVersions ? (
                <div className="flex justify-center p-4">
                  <Loader2 className="animate-spin text-cyan-500" size={24} />
                </div>
              ) : versions.length === 0 ? (
                <div className="text-center text-sm text-gray-500 mt-4">
                  No version history found.
                </div>
              ) : (
                versions.map((v, i) => (
                  <div key={v.id} className="bg-gray-800/50 border border-gray-700/50 p-3 rounded-xl">
                    <div className="flex justify-between items-start mb-2">
                      <div>
                        <span className="text-sm font-medium text-gray-200">Version {v.version_number}</span>
                        {i === 0 && <span className="ml-2 text-[10px] uppercase tracking-wider bg-cyan-500/20 text-cyan-400 px-1.5 py-0.5 rounded">Current</span>}
                      </div>
                      <span className="text-xs text-gray-500">{formatBytes(v.size)}</span>
                    </div>
                    <div className="text-xs text-gray-400 mb-3">
                      {formatRelative(v.created_at)}
                    </div>
                    {i !== 0 && (
                      <button
                        onClick={() => handleRestore(v.version_number)}
                        disabled={restoringVersion === v.version_number}
                        className="w-full flex items-center justify-center gap-2 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-gray-200 text-xs font-medium rounded-lg transition-colors"
                      >
                        {restoringVersion === v.version_number ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <RotateCcw size={14} />
                        )}
                        Restore this version
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        )}
        {showInfo && !showVersions && (
          <div className="w-80 border-l border-gray-800 bg-gray-900 p-5 text-sm">
            <h4 className="font-medium text-gray-200 mb-5">File details</h4>
            <dl className="space-y-4 text-gray-400">
              <div><dt className="text-xs uppercase text-gray-600">Type</dt><dd className="mt-1 break-all">{metadata.mime_type || 'Unknown'}</dd></div>
              <div><dt className="text-xs uppercase text-gray-600">Size</dt><dd className="mt-1">{formatBytes(metadata.size)}</dd></div>
              <div><dt className="text-xs uppercase text-gray-600">Created</dt><dd className="mt-1">{metadata.created_at ? new Date(metadata.created_at).toLocaleString() : 'Unknown'}</dd></div>
              <div><dt className="text-xs uppercase text-gray-600">Updated</dt><dd className="mt-1">{metadata.updated_at ? new Date(metadata.updated_at).toLocaleString() : 'Unknown'}</dd></div>
              <div><dt className="text-xs uppercase text-gray-600">Current version</dt><dd className="mt-1">{metadata.current_version || 1}</dd></div>
              {metadata.checksum_sha256 && <div><dt className="text-xs uppercase text-gray-600">SHA-256</dt><dd className="mt-1 break-all font-mono text-xs">{metadata.checksum_sha256}</dd></div>}
            </dl>
          </div>
        )}
      </div>
    </div>
    </div>
  );
}
