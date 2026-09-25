'use client';

import { useEffect, useState } from 'react';
import { X, Share2, Copy, Check, Lock, Calendar, DownloadCloud, Loader2, Link2, Trash2 } from 'lucide-react';
import { shareApi } from '@/lib/api';
import { FileItem } from '@/app/dashboard/page';

interface Props {
  file: FileItem;
  onClose: () => void;
}

interface ShareLinkItem {
  id: string;
  token: string;
  has_password: boolean;
  expires_at: string | null;
  max_downloads: number | null;
  download_count: number;
  is_active: boolean;
}

const isLinkActive = (link: ShareLinkItem) => {
  const expired = Boolean(link.expires_at && new Date(link.expires_at) < new Date());
  const exhausted = Boolean(link.max_downloads && link.download_count >= link.max_downloads);
  return link.is_active && !expired && !exhausted;
};

export function ShareModal({ file, onClose }: Props) {
  const [password, setPassword] = useState('');
  const [expiresInDays, setExpiresInDays] = useState<number | ''>('');
  const [maxDownloads, setMaxDownloads] = useState<number | ''>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [shareLink, setShareLink] = useState('');
  const [copied, setCopied] = useState(false);
  const [links, setLinks] = useState<ShareLinkItem[]>([]);
  const [loadingLinks, setLoadingLinks] = useState(true);
  const [revokeTarget, setRevokeTarget] = useState<ShareLinkItem | null>(null);
  const [revoking, setRevoking] = useState(false);

  const loadLinks = async () => {
    setLoadingLinks(true);
    try {
      const data = await shareApi.listFileLinks(file.id) as { links: ShareLinkItem[] };
      setLinks(data.links || []);
    } catch (err: any) {
      setError(err.message || 'Failed to load existing links');
    } finally {
      setLoadingLinks(false);
    }
  };

  useEffect(() => { void loadLinks(); }, [file.id]);

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
      await loadLinks();
    } catch (err: any) {
      setError(err.message || 'Failed to create share link');
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = async (link = shareLink) => {
    await navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const revokeLink = async () => {
    if (!revokeTarget) return;
    setRevoking(true);
    setError('');
    try {
      await shareApi.revokeLink(revokeTarget.id);
      setLinks(current => current.map(link => link.id === revokeTarget.id ? { ...link, is_active: false } : link));
      setRevokeTarget(null);
    } catch (err: any) {
      setError(err.message || 'Failed to revoke link');
    } finally {
      setRevoking(false);
    }
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
                  onClick={() => copyToClipboard()}
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

          <div className="mt-7 border-t border-gray-800 pt-6">
            <div className="mb-3 flex items-center justify-between"><h4 className="flex items-center gap-2 font-medium text-gray-200"><Link2 size={17} /> Existing links</h4><span className="text-xs text-gray-500">{links.filter(isLinkActive).length} active</span></div>
            {loadingLinks ? <div className="py-5 text-center"><Loader2 className="mx-auto animate-spin text-cyan-500" size={20} /></div> : links.length === 0 ? <p className="rounded-xl bg-gray-800/40 p-4 text-center text-sm text-gray-500">No share links yet.</p> : <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
              {links.map(link => {
                const expired = link.expires_at && new Date(link.expires_at) < new Date();
                const exhausted = link.max_downloads && link.download_count >= link.max_downloads;
                const active = isLinkActive(link);
                const url = `${window.location.origin}/share/${link.token}`;
                return <div key={link.id} className="rounded-xl border border-gray-800 bg-gray-950/40 p-3">
                  <div className="flex items-start gap-3"><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${active ? 'bg-green-400' : 'bg-gray-600'}`} /><span className={`text-xs font-medium ${active ? 'text-green-400' : 'text-gray-500'}`}>{active ? 'Active' : expired ? 'Expired' : exhausted ? 'Limit reached' : 'Revoked'}</span>{link.has_password && <Lock size={12} className="text-yellow-400" />}</div><p className="mt-1 truncate text-xs text-gray-500">{url}</p><p className="mt-1 text-[11px] text-gray-600">{link.download_count}{link.max_downloads ? ` / ${link.max_downloads}` : ''} downloads · {link.expires_at ? `expires ${new Date(link.expires_at).toLocaleDateString()}` : 'no expiry'}</p></div><button onClick={() => copyToClipboard(url)} className="p-1.5 text-gray-500 hover:text-cyan-400" title="Copy link"><Copy size={15} /></button>{link.is_active && <button onClick={() => setRevokeTarget(link)} className="p-1.5 text-gray-500 hover:text-red-400" title="Revoke link"><Trash2 size={15} /></button>}</div>
                </div>;
              })}
            </div>}
          </div>
        </div>

        {revokeTarget && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/75 p-5 backdrop-blur-sm">
            <div role="dialog" aria-modal="true" aria-labelledby="revoke-link-title" className="w-full rounded-2xl border border-gray-700 bg-gray-900 p-5 shadow-2xl">
              <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-red-500/15 text-red-400"><Trash2 size={21} /></div>
              <h4 id="revoke-link-title" className="text-lg font-semibold text-white">Revoke this link?</h4>
              <p className="mt-2 text-sm text-gray-400">Anyone using it will immediately lose access. The revoked link will remain visible in your sharing history.</p>
              <div className="mt-5 flex justify-end gap-3">
                <button disabled={revoking} onClick={() => setRevokeTarget(null)} className="rounded-xl bg-gray-800 px-4 py-2.5 text-sm font-medium text-gray-200 hover:bg-gray-700 disabled:opacity-50">Cancel</button>
                <button disabled={revoking} onClick={revokeLink} className="flex items-center gap-2 rounded-xl bg-red-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50">{revoking ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />} Revoke link</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
