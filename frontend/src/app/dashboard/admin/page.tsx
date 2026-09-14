'use client';

import { useState, useEffect } from 'react';
import { Shield, Users, UserCheck, HardDrive, Database, Ban, CheckCircle, Edit2, Loader2, AlertCircle } from 'lucide-react';
import { adminApi } from '@/lib/api';
import { formatBytes } from '@/lib/utils';
import { useAuth } from '@/lib/auth-context';
import { useRouter } from 'next/navigation';

interface UserData {
  id: string;
  email: string;
  username: string;
  role: string;
  is_active: boolean;
  storage_quota: number;
  storage_used: number;
  created_at: string;
}

interface AdminStats {
  total_users: number;
  active_users: number;
  total_storage_used: number;
  total_storage_quota: number;
}

export default function AdminDashboard() {
  const { user } = useAuth();
  const router = useRouter();
  
  const [users, setUsers] = useState<UserData[]>([]);
  const [stats, setStats] = useState<AdminStats | null>(null);
  
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Edit State
  const [editingUser, setEditingUser] = useState<UserData | null>(null);
  const [newQuota, setNewQuota] = useState('');

  useEffect(() => {
    if (user && user.role !== 'admin') {
      router.push('/dashboard');
    } else if (user) {
      loadData();
    }
  }, [user, router]);

  const loadData = async () => {
    try {
      const [usersData, statsData] = await Promise.all([
        adminApi.getUsers(),
        adminApi.getStats()
      ]);
      setUsers(usersData as UserData[]);
      setStats(statsData as AdminStats);
      setLoading(false);
    } catch (err: any) {
      setError('Failed to load admin data');
      setLoading(false);
    }
  };

  const handleToggleRole = async (userId: string, currentRole: string) => {
    try {
      const newRole = currentRole === 'admin' ? 'user' : 'admin';
      await adminApi.updateRole(userId, newRole);
      loadData();
    } catch {
      alert('Failed to update role');
    }
  };

  const handleToggleStatus = async (userId: string, currentStatus: boolean) => {
    if (userId === user?.id) {
      alert('You cannot change your own status.');
      return;
    }
    try {
      await adminApi.updateStatus(userId, !currentStatus);
      loadData();
    } catch {
      alert('Failed to update status');
    }
  };

  const handleUpdateQuota = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingUser || !newQuota) return;
    try {
      // Parse quota in GB to bytes
      const quotaBytes = parseFloat(newQuota) * 1024 * 1024 * 1024;
      await adminApi.updateQuota(editingUser.id, quotaBytes);
      setEditingUser(null);
      setNewQuota('');
      loadData();
    } catch {
      alert('Failed to update quota');
    }
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
      </div>
    );
  }

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-8">
      {/* Header */}
      <div className="flex items-center gap-4">
        <div className="p-4 rounded-2xl bg-gradient-to-br from-blue-500 to-purple-600 shadow-lg shadow-blue-500/20 flex items-center justify-center">
          <Shield className="w-8 h-8 text-white" strokeWidth={2.5} />
        </div>
        <div>
          <h1 className="text-3xl font-bold text-white tracking-tight">Admin Panel</h1>
          <p className="text-gray-400 mt-1">Manage platform users, roles, and storage quotas.</p>
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 text-red-400 p-4 rounded-xl flex items-center gap-3">
          <AlertCircle className="w-5 h-5 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* Analytics Dashboard */}
      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {/* Card 1: Total Users */}
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 relative overflow-hidden group hover:border-gray-700 transition-colors">
            <div className="absolute top-0 right-0 w-32 h-32 bg-blue-500/5 rounded-full blur-3xl -mr-16 -mt-16 transition-all group-hover:bg-blue-500/10"></div>
            <div className="flex items-center gap-4 mb-4 relative z-10">
              <div className="p-3 bg-blue-500/10 rounded-xl text-blue-400">
                <Users className="w-6 h-6" />
              </div>
              <h3 className="text-gray-400 font-medium">Total Users</h3>
            </div>
            <div className="text-3xl font-bold text-white relative z-10">{stats.total_users}</div>
          </div>

          {/* Card 2: Active Users */}
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 relative overflow-hidden group hover:border-gray-700 transition-colors">
            <div className="absolute top-0 right-0 w-32 h-32 bg-emerald-500/5 rounded-full blur-3xl -mr-16 -mt-16 transition-all group-hover:bg-emerald-500/10"></div>
            <div className="flex items-center gap-4 mb-4 relative z-10">
              <div className="p-3 bg-emerald-500/10 rounded-xl text-emerald-400">
                <UserCheck className="w-6 h-6" />
              </div>
              <h3 className="text-gray-400 font-medium">Active Users</h3>
            </div>
            <div className="text-3xl font-bold text-white relative z-10">{stats.active_users}</div>
          </div>

          {/* Card 3: Storage Used */}
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 relative overflow-hidden group hover:border-gray-700 transition-colors">
            <div className="absolute top-0 right-0 w-32 h-32 bg-amber-500/5 rounded-full blur-3xl -mr-16 -mt-16 transition-all group-hover:bg-amber-500/10"></div>
            <div className="flex items-center gap-4 mb-4 relative z-10">
              <div className="p-3 bg-amber-500/10 rounded-xl text-amber-400">
                <HardDrive className="w-6 h-6" />
              </div>
              <h3 className="text-gray-400 font-medium">Storage Used</h3>
            </div>
            <div className="text-3xl font-bold text-white relative z-10">{formatBytes(stats.total_storage_used)}</div>
          </div>

          {/* Card 4: Total Quota */}
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 relative overflow-hidden group hover:border-gray-700 transition-colors">
            <div className="absolute top-0 right-0 w-32 h-32 bg-purple-500/5 rounded-full blur-3xl -mr-16 -mt-16 transition-all group-hover:bg-purple-500/10"></div>
            <div className="flex items-center gap-4 mb-4 relative z-10">
              <div className="p-3 bg-purple-500/10 rounded-xl text-purple-400">
                <Database className="w-6 h-6" />
              </div>
              <h3 className="text-gray-400 font-medium">Total Quota</h3>
            </div>
            <div className="text-3xl font-bold text-white relative z-10">{formatBytes(stats.total_storage_quota)}</div>
          </div>
        </div>
      )}

      {/* Users Table */}
      <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-gray-900 border-b border-gray-800">
                <th className="p-5 font-medium text-gray-400 text-sm uppercase tracking-wider">User</th>
                <th className="p-5 font-medium text-gray-400 text-sm uppercase tracking-wider">Role</th>
                <th className="p-5 font-medium text-gray-400 text-sm uppercase tracking-wider">Storage Usage</th>
                <th className="p-5 font-medium text-gray-400 text-sm uppercase tracking-wider text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {users.map((u) => (
                <tr key={u.id} className="hover:bg-gray-800/50 transition-colors">
                  <td className="p-5">
                    <div className="flex items-center gap-3">
                      <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm ${
                        u.is_active ? 'bg-gray-800 text-gray-200' : 'bg-red-500/10 text-red-500'
                      }`}>
                        {u.username.charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <div className="font-medium text-gray-100 flex items-center gap-2">
                          {u.username}
                          {!u.is_active && (
                            <span className="px-2 py-0.5 rounded-full bg-red-500/10 text-red-400 text-[10px] font-bold uppercase tracking-wider">Banned</span>
                          )}
                        </div>
                        <div className="text-sm text-gray-500">{u.email}</div>
                      </div>
                    </div>
                  </td>
                  <td className="p-5">
                    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border ${
                      u.role === 'admin' 
                        ? 'bg-purple-500/10 text-purple-400 border-purple-500/20' 
                        : 'bg-gray-800 text-gray-300 border-gray-700'
                    }`}>
                      {u.role}
                    </span>
                  </td>
                  <td className="p-5 w-64">
                    <div className="flex flex-col gap-2">
                      <div className="text-sm text-gray-300 flex justify-between">
                        <span>{formatBytes(u.storage_used)}</span>
                        <span className="text-gray-500">{formatBytes(u.storage_quota)}</span>
                      </div>
                      <div className="w-full h-1.5 bg-gray-800 rounded-full overflow-hidden">
                        <div 
                          className={`h-full rounded-full transition-all ${
                            (u.storage_used / u.storage_quota) > 0.9 ? 'bg-red-500' : 'bg-blue-500'
                          }`}
                          style={{ width: `${Math.min(100, (u.storage_used / u.storage_quota) * 100)}%` }}
                        />
                      </div>
                    </div>
                  </td>
                  <td className="p-5">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => handleToggleRole(u.id, u.role)}
                        className={`p-2 rounded-xl transition-colors ${
                          u.role === 'admin' 
                            ? 'text-gray-400 hover:text-purple-400 hover:bg-purple-500/10'
                            : 'text-gray-400 hover:text-blue-400 hover:bg-blue-500/10'
                        }`}
                        title={u.role === 'admin' ? 'Demote to User' : 'Promote to Admin'}
                      >
                        <Shield className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => {
                          setEditingUser(u);
                          setNewQuota((u.storage_quota / (1024 * 1024 * 1024)).toString());
                        }}
                        className="p-2 text-gray-400 hover:text-emerald-400 hover:bg-emerald-500/10 rounded-xl transition-colors"
                        title="Edit Quota"
                      >
                        <HardDrive className="w-4 h-4" />
                      </button>
                      {u.is_active !== undefined && (
                        <button
                          onClick={() => handleToggleStatus(u.id, u.is_active)}
                          className={`p-2 rounded-xl transition-colors ${
                            u.is_active 
                              ? 'text-gray-400 hover:text-red-400 hover:bg-red-500/10' 
                              : 'text-red-400 bg-red-500/10 hover:bg-red-500/20'
                          }`}
                          title={u.is_active ? 'Ban User' : 'Unban User'}
                          disabled={u.id === user?.id}
                        >
                          <Ban className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {users.length === 0 && (
                <tr>
                  <td colSpan={4} className="p-8 text-center text-gray-500">
                    No users found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Edit Quota Modal */}
      {editingUser && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-md overflow-hidden shadow-2xl">
            <div className="p-6 border-b border-gray-800 flex items-center justify-between">
              <h3 className="text-lg font-bold text-white">Edit Storage Quota</h3>
              <button 
                onClick={() => setEditingUser(null)}
                className="text-gray-400 hover:text-white transition-colors"
              >
                &times;
              </button>
            </div>
            
            <form onSubmit={handleUpdateQuota} className="p-6">
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-400 mb-1">
                  User: <span className="text-white">{editingUser.username}</span>
                </label>
                <div className="text-sm text-gray-500 mb-6">
                  Currently using {formatBytes(editingUser.storage_used)}
                </div>
                
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  New Quota (GB)
                </label>
                <input
                  type="number"
                  step="0.1"
                  min="0.1"
                  value={newQuota}
                  onChange={(e) => setNewQuota(e.target.value)}
                  className="w-full bg-gray-950 border border-gray-800 text-white px-4 py-3 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500"
                  required
                />
              </div>
              
              <div className="flex justify-end gap-3 mt-8">
                <button
                  type="button"
                  onClick={() => setEditingUser(null)}
                  className="px-4 py-2 text-gray-400 hover:text-white hover:bg-gray-800 rounded-xl transition-colors font-medium"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-6 py-2 bg-blue-600 text-white rounded-xl hover:bg-blue-500 transition-colors shadow-lg shadow-blue-500/20 font-medium"
                >
                  Save Quota
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
