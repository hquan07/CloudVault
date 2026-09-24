import { useState } from 'react';
import { X, Users, Check, Loader2 } from 'lucide-react';
import { fileApi } from '@/lib/api';

interface Props {
  folder: { id: string; name: string };
  onClose: () => void;
}

export function ShareFolderModal({ folder, onClose }: Props) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('viewer');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const handleShare = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;

    try {
      setLoading(true);
      setError('');
      setSuccess(false);

      await fileApi.shareFolder(folder.id, email, role);

      setSuccess(true);
      setEmail('');
      
      // Auto close after 2 seconds on success
      setTimeout(() => {
        onClose();
      }, 2000);

    } catch (err: any) {
      setError(err.message || 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="w-full max-w-md bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200">
        
        <div className="flex items-center justify-between p-6 border-b border-gray-800">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-cyan-900/30 rounded-full flex items-center justify-center text-cyan-400">
              <Users size={20} />
            </div>
            <div>
              <h3 className="text-lg font-medium text-white">Share Folder</h3>
              <p className="text-sm text-gray-400">{folder.name}</p>
            </div>
          </div>
          <button 
            onClick={onClose}
            className="p-2 text-gray-400 hover:text-white hover:bg-gray-800 rounded-xl transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleShare} className="p-6">
          {error && (
            <div className="mb-6 p-3 bg-red-900/30 border border-red-500/30 rounded-xl text-red-400 text-sm">
              {error}
            </div>
          )}

          {success && (
            <div className="mb-6 p-3 bg-green-900/30 border border-green-500/30 rounded-xl text-green-400 text-sm flex items-center gap-2">
              <Check size={16} />
              Folder shared successfully!
            </div>
          )}

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1.5">User Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Enter user email..."
                className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition-colors"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1.5">Role</label>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value)}
                className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition-colors appearance-none"
              >
                <option value="viewer">Viewer (Read-only)</option>
                <option value="editor">Editor (Can upload/edit)</option>
                <option value="manager">Manager (Can share/delete)</option>
              </select>
            </div>
          </div>

          <div className="mt-8 flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2.5 bg-gray-800 hover:bg-gray-700 text-white rounded-xl font-medium transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !email.trim()}
              className="flex-1 px-4 py-2.5 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-xl font-medium transition-colors flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <Loader2 size={18} className="animate-spin" />
                  Sharing...
                </>
              ) : (
                'Share Folder'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
