import { useState, useEffect } from 'react';
import { X, User as UserIcon, Save, Loader2, Check } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { authApi } from '@/lib/api';
import { formatBytes } from '@/lib/utils';

interface SettingsModalProps {
  onClose: () => void;
}

export function SettingsModal({ onClose }: SettingsModalProps) {
  const { user, refreshUser } = useAuth();
  
  const [username, setUsername] = useState(user?.username || '');
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');

  // Close on Escape key
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [onClose]);

  if (!user) return null;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || username === user.username) {
      if (username === user.username) onClose();
      return;
    }

    setSaving(true);
    setError('');
    try {
      await authApi.updateProfile({ username });
      await refreshUser(); // Refresh the user context
      setSuccess(true);
      setTimeout(() => {
        onClose();
      }, 1000);
    } catch (err: any) {
      setError(err.message || 'Failed to update profile');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative w-full max-w-md bg-gray-900 border border-gray-800 rounded-3xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        <div className="flex items-center justify-between p-6 border-b border-gray-800 bg-gray-900/50">
          <h2 className="text-xl font-bold flex items-center gap-2">
            <UserIcon className="text-cyan-400" /> Account Settings
          </h2>
          <button 
            onClick={onClose}
            className="p-2 text-gray-400 hover:text-white hover:bg-gray-800 rounded-xl transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSave} className="p-6 space-y-6">
          {error && (
            <div className="p-3 bg-red-500/10 border border-red-500/30 text-red-400 rounded-xl text-sm">
              {error}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-400 mb-2">Email Address</label>
            <input 
              type="text" 
              value={user.email} 
              disabled 
              className="w-full bg-gray-800/50 border border-gray-800 rounded-xl px-4 py-3 text-gray-500 cursor-not-allowed"
            />
            <p className="text-xs text-gray-500 mt-2">Email cannot be changed.</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-400 mb-2">Display Name</label>
            <input 
              type="text" 
              value={username} 
              onChange={e => setUsername(e.target.value)}
              placeholder="Enter your display name"
              className="w-full bg-gray-950 border border-gray-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500/50 transition-all placeholder:text-gray-600"
            />
          </div>

          <div className="p-4 bg-cyan-900/10 border border-cyan-500/20 rounded-xl">
            <h4 className="text-sm font-medium text-cyan-400 mb-1">Storage Usage</h4>
            <div className="flex justify-between text-xs text-gray-400 mb-2">
              <span>{formatBytes(user.storage_used)} used</span>
              <span>{formatBytes(user.storage_quota)} total</span>
            </div>
            <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
              <div 
                className="h-full bg-gradient-to-r from-cyan-500 to-blue-500"
                style={{ width: `${Math.min(100, (user.storage_used / user.storage_quota) * 100)}%` }}
              />
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t border-gray-800">
            <button
              type="button"
              onClick={onClose}
              className="px-5 py-2.5 text-gray-300 hover:text-white font-medium transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || (username === user.username && !success)}
              className={`flex items-center gap-2 px-6 py-2.5 rounded-xl font-semibold transition-all duration-300 ${
                success 
                  ? 'bg-green-500 text-white' 
                  : 'bg-cyan-500 hover:bg-cyan-400 text-gray-950 disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-cyan-900/30'
              }`}
            >
              {saving ? <Loader2 size={18} className="animate-spin" /> : (success ? <Check size={18} /> : <Save size={18} />)}
              {success ? 'Saved!' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
