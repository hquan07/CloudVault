'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Lock, File as FileIcon, Download, AlertCircle, Loader2 } from 'lucide-react';
import { shareApi } from '@/lib/api';
import { formatBytes, formatRelative } from '@/lib/utils';
import Image from 'next/image';

export default function ShareAccessPage() {
  const params = useParams();
  const token = params.token as string;
  
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  
  const [requiresPassword, setRequiresPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [verifying, setVerifying] = useState(false);
  
  const [fileInfo, setFileInfo] = useState<any>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);

  useEffect(() => {
    const fetchPublicShare = async () => {
      try {
        const data = await shareApi.accessPublic(token) as any;
        if (data.requires_password) {
          setRequiresPassword(true);
        } else if (data.file) {
          setFileInfo(data.file);
          setDownloadUrl(data.download_url);
        }
      } catch (err: any) {
        if (err.status === 404 || err.status === 410) {
          setError(err.message || 'Share link unavailable');
        } else {
          setError('An error occurred while loading this link');
        }
      } finally {
        setLoading(false);
      }
    };
    
    if (token) {
      fetchPublicShare();
    }
  }, [token]);

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;
    
    setVerifying(true);
    setPasswordError('');
    try {
      const data = await shareApi.accessWithPassword(token, password) as any;
      setRequiresPassword(false);
      setFileInfo(data.file);
      setDownloadUrl(data.download_url);
    } catch (err: any) {
      setPasswordError('Incorrect password');
    } finally {
      setVerifying(false);
    }
  };

  const handleDownload = () => {
    if (downloadUrl) {
      window.location.href = downloadUrl;
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-950 flex flex-col items-center justify-center text-cyan-500">
        <Loader2 className="animate-spin mb-4" size={48} />
        <p className="text-gray-400 font-medium">Verifying link...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-950 flex flex-col items-center justify-center p-6">
        <div className="max-w-md w-full bg-gray-900 border border-red-500/30 rounded-3xl p-8 text-center">
          <div className="w-16 h-16 bg-red-500/10 text-red-500 rounded-full flex items-center justify-center mx-auto mb-6">
            <AlertCircle size={32} />
          </div>
          <h1 className="text-2xl font-bold text-gray-100 mb-2">Link Unavailable</h1>
          <p className="text-gray-400 mb-8">{error}</p>
          <a href="/" className="inline-block bg-gray-800 hover:bg-gray-700 text-white font-medium py-3 px-8 rounded-xl transition-colors">
            Go to CloudVault
          </a>
        </div>
      </div>
    );
  }

  if (requiresPassword) {
    return (
      <div className="min-h-screen bg-gray-950 flex flex-col items-center justify-center p-6">
        <div className="max-w-md w-full bg-gray-900 border border-gray-800 rounded-3xl p-8 animate-in fade-in zoom-in-95 duration-300">
          <div className="w-16 h-16 bg-blue-500/10 text-blue-400 rounded-2xl flex items-center justify-center mx-auto mb-6">
            <Lock size={32} />
          </div>
          <h1 className="text-2xl font-bold text-center text-gray-100 mb-2">Password Protected</h1>
          <p className="text-center text-gray-400 mb-8">This file is protected. Please enter the password to view and download.</p>
          
          <form onSubmit={handlePasswordSubmit} className="space-y-6">
            <div>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Enter password"
                autoFocus
                className="w-full bg-gray-950/50 border border-gray-700 rounded-xl px-4 py-4 text-center text-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all placeholder:text-gray-600"
              />
              {passwordError && (
                <p className="text-red-400 text-sm mt-2 text-center">{passwordError}</p>
              )}
            </div>
            
            <button
              type="submit"
              disabled={verifying || !password}
              className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500 text-white font-semibold py-4 px-4 rounded-xl transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-cyan-400 focus:ring-offset-2 focus:ring-offset-gray-900 shadow-lg shadow-cyan-900/30 disabled:opacity-50"
            >
              {verifying ? <Loader2 className="animate-spin" size={20} /> : 'Unlock File'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (fileInfo) {
    return (
      <div className="min-h-screen bg-gray-950 flex flex-col items-center justify-center p-6 bg-[url('/grid-pattern.svg')] bg-repeat">
        <div className="max-w-xl w-full bg-gray-900/80 backdrop-blur-xl border border-gray-800 rounded-3xl p-8 shadow-2xl shadow-cyan-900/10 animate-in fade-in slide-in-from-bottom-8 duration-500">
          <div className="flex flex-col items-center text-center">
            
            {fileInfo.thumbnail_url ? (
              <div className="w-32 h-32 rounded-2xl overflow-hidden mb-6 border border-gray-700 shadow-lg relative">
                <Image src={fileInfo.thumbnail_url} alt="Thumbnail" fill className="object-cover" />
              </div>
            ) : (
              <div className="w-24 h-24 bg-gray-800 rounded-2xl flex items-center justify-center text-cyan-400 mb-6 shadow-lg shadow-cyan-900/20">
                <FileIcon size={48} />
              </div>
            )}
            
            <h1 className="text-2xl font-bold text-gray-100 mb-2 truncate w-full" title={fileInfo.original_name}>
              {fileInfo.original_name}
            </h1>
            
            <div className="flex items-center gap-4 text-sm text-gray-400 mb-8">
              <span>{formatBytes(fileInfo.size)}</span>
              <span>•</span>
              <span>{fileInfo.mime_type}</span>
              <span>•</span>
              <span>{formatRelative(fileInfo.created_at)}</span>
            </div>
            
            {downloadUrl ? (
              <button
                onClick={handleDownload}
                className="w-full flex items-center justify-center gap-3 bg-white hover:bg-gray-100 text-gray-900 font-bold py-4 px-8 rounded-xl transition-all duration-300 transform hover:scale-105 active:scale-95 shadow-xl shadow-white/10"
              >
                <Download size={24} />
                Download File
              </button>
            ) : (
              <button disabled className="w-full flex items-center justify-center gap-3 bg-gray-800 text-gray-500 font-bold py-4 px-8 rounded-xl cursor-not-allowed">
                <AlertCircle size={24} />
                Download Unavailable
              </button>
            )}
            
            <p className="text-xs text-gray-500 mt-8">Shared securely via CloudVault</p>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
