'use client';

import { useState } from 'react';
import { X, Share2, Copy, Check, Lock, Calendar, DownloadCloud, Loader2 } from 'lucide-react';
import { shareApi } from '@/lib/api';
import { FileItem } from '@/app/dashboard/page';

interface Props {
  file: FileItem;
  onClose: () => void;
}

export function ShareModal({ file, onClose }: Props) {
  const [password, setPassword] = useState('');
  const [expiresInDays, setExpiresInDays] = useState<number | ''>('');
  const [maxDownloads, setMaxDownloads] = useState<number | ''>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [shareLink, setShareLink] = useState('');
  const [copied, setCopied] = useState(false);

  const handleCreateLink = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const data = await shareApi.createLink({
        file_id: file.id,
        password: password || undefined,
        expires_in_days: expiresInDays ? Number(expiresInDays) : undefined,
        max_downloads: maxDownloads ? Number(maxDownloads) : undefined,
      }) as any;
      
      const link = `${window.location.origin}/share/${data.token}`;
      setShareLink(link);
    } catch (err: any) {
      setError(err.message || 'Failed to create share link');
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(shareLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 animate-in fade-in duration-200">
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md bg-gray-900 border border-gray-800 rounded-3xl shadow-2xl flex flex-col overflow-hidden animate-in zoom-in-95 duration-200">
        
        <div className="flex items-center justify-between p-6 border-b border-gray-800 bg-gray-900/50">
          <div className="flex items-center gap-3 text-cyan-400">
            <div className="p-2 bg-cyan-900/30 rounded-xl">
              <Share2 size={24} />
            </div>
            <h3 className="font-bold text-xl text-gray-100">Share File</h3>
          </div>
          <button onClick={onClose} className="p-2 text-gray-400 hover:text-red-400 hover:bg-gray-800 rounded-xl transition-colors">
            <X size={20} />
          </button>
        </div>

        <div className="p-6 overflow-y-auto max-h-[70vh]">
          <div className="mb-6 p-4 bg-gray-800/50 rounded-xl border border-gray-700/50">
            <p className="text-sm text-gray-400 mb-1">Sharing</p>
            <p className="font-medium text-gray-200 truncate">{file.original_name}</p>
          </div>

          {error && (
            <div className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded-xl text-sm mb-6">
              {error}
            </div>
          )}

          {!shareLink ? (
            <form onSubmit={handleCreateLink} className="space-y-5">
              <div>
                <label className="flex items-center gap-2 text-sm font-medium text-gray-400 mb-2">
                  <Lock size={16} /> Password Protection (Optional)
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="Leave empty for public access"
                  className="w-full bg-gray-950/50 border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/50 transition-all placeholder:text-gray-600"
                />
              </div>

              <div>
                <label className="flex items-center gap-2 text-sm font-medium text-gray-400 mb-2">
                  <Calendar size={16} /> Expiry (Optional)
                </label>
                <div className="relative">
                  <input
                    type="number"
                    min="1"
                    max="365"
                    value={expiresInDays}
                    onChange={e => setExpiresInDays(e.target.value === '' ? '' : Number(e.target.value))}
                    placeholder="e.g., 7"
                    className="w-full bg-gray-950/50 border border-gray-700 rounded-xl pl-4 pr-16 py-3 text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/50 transition-all placeholder:text-gray-600"
                  />
                  <span className="absolute right-4 top-3.5 text-gray-500 text-sm">days</span>
                </div>
              </div>

              <div>
                <label className="flex items-center gap-2 text-sm font-medium text-gray-400 mb-2">
                  <DownloadCloud size={16} /> Download Limit (Optional)
                </label>
                <div className="relative">
                  <input
                    type="number"
                    min="1"
                    value={maxDownloads}
                    onChange={e => setMaxDownloads(e.target.value === '' ? '' : Number(e.target.value))}
                    placeholder="e.g., 10"
                    className="w-full bg-gray-950/50 border border-gray-700 rounded-xl pl-4 pr-20 py-3 text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/50 transition-all placeholder:text-gray-600"
                  />
                  <span className="absolute right-4 top-3.5 text-gray-500 text-sm">times</span>
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full mt-4 flex items-center justify-center gap-2 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-semibold py-3.5 px-4 rounded-xl transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-cyan-400 focus:ring-offset-2 focus:ring-offset-gray-900 shadow-lg shadow-cyan-900/30 disabled:opacity-50 group-hover:shadow-cyan-900/50"
              >
                {loading ? <Loader2 className="animate-spin" size={20} /> : <Share2 size={20} />}
                {loading ? 'Creating...' : 'Create Link'}
              </button>
            </form>
          ) : (
            <div className="space-y-6">
              <div className="bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 p-4 rounded-xl text-center">
                <p className="font-medium text-lg">Link created successfully!</p>
                <p className="text-sm opacity-80 mt-1">Anyone with the link can access the file.</p>
              </div>

              <div className="relative">
                <input
                  type="text"
                  readOnly
                  value={shareLink}
                  className="w-full bg-gray-950/50 border border-gray-700 rounded-xl pl-4 pr-14 py-4 text-gray-300 focus:outline-none"
                />
                <button
                  onClick={copyToClipboard}
                  className="absolute right-2 top-2 bottom-2 aspect-square flex items-center justify-center bg-gray-800 hover:bg-gray-700 text-cyan-400 rounded-lg transition-colors"
                  title="Copy link"
                >
                  {copied ? <Check size={18} className="text-green-400" /> : <Copy size={18} />}
                </button>
              </div>

              <button
                onClick={onClose}
                className="w-full bg-gray-800 hover:bg-gray-700 text-white font-medium py-3.5 px-4 rounded-xl transition-colors"
              >
                Done
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
