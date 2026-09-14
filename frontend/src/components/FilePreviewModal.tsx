'use client';

import { X, Download, AlertCircle, Loader2, FileIcon } from 'lucide-react';
import { useState, useEffect } from 'react';
import { fileApi } from '@/lib/api';
import { formatBytes } from '@/lib/utils';

export interface FileItem {
  id: string;
  filename?: string;
  original_name: string;
  mime_type: string;
  size: number;
}

interface Props {
  file: FileItem;
  onClose: () => void;
}

export function FilePreviewModal({ file, onClose }: Props) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const fetchUrl = async () => {
      try {
        const data = await fileApi.download(file.id);
        if (data.download_url) {
          setUrl(data.download_url);
        } else {
          setError('Could not generate preview URL');
        }
      } catch (err: any) {
        setError(err.message || 'Failed to load preview');
      } finally {
        setLoading(false);
      }
    };
    fetchUrl();
  }, [file.id]);

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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 animate-in fade-in duration-200">
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-5xl h-[85vh] bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl flex flex-col overflow-hidden animate-in zoom-in-95 duration-200">
        
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

        {/* Content */}
        <div className="flex-1 overflow-hidden bg-black/40 flex items-center justify-center p-4 relative">
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
                <video src={url!} controls autoPlay className="max-w-full max-h-full rounded-lg shadow-lg bg-black" />
              )}
              {isAudio && (
                <audio src={url!} controls className="w-full max-w-md" />
              )}
              {(isPdf || isText) && (
                <iframe src={url!} className="w-full h-full rounded-lg bg-white" title={file.original_name} />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
