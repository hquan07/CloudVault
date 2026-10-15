import { useCallback, useEffect, useState } from 'react';
import {
  BadgeCheck,
  CalendarDays,
  Check,
  HardDrive,
  KeyRound,
  Loader2,
  LogOut,
  Mail,
  MonitorSmartphone,
  Save,
  ShieldCheck,
  Trash2,
  User as UserIcon,
  X,
} from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { ApiError, AuthSession, authApi } from '@/lib/api';
import { formatBytes } from '@/lib/utils';

interface SettingsModalProps {
  onClose: () => void;
}

type SettingsSection = 'profile' | 'security' | 'sessions';

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function describeAgent(userAgent: string | null) {
  if (!userAgent) return 'Unknown device';
  if (/Firefox/i.test(userAgent)) return 'Firefox browser';
  if (/Edg/i.test(userAgent)) return 'Microsoft Edge';
  if (/Chrome/i.test(userAgent)) return 'Chrome browser';
  if (/Safari/i.test(userAgent)) return 'Safari browser';
  if (/curl/i.test(userAgent)) return 'API / curl client';
  return userAgent.slice(0, 80);
}

export function SettingsModal({ onClose }: SettingsModalProps) {
  const { user, refreshUser, logout } = useAuth();
  const [section, setSection] = useState<SettingsSection>('profile');
  const [username, setUsername] = useState(user?.username || '');
  const [avatarUrl, setAvatarUrl] = useState(user?.avatar_url || '');
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState('');
  const [error, setError] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [sessions, setSessions] = useState<AuthSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const resetMessages = () => {
    setError('');
    setSuccess('');
  };

  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    try {
      setSessions(await authApi.listSessions());
    } catch (loadError: unknown) {
      setError(errorMessage(loadError, 'Failed to load sessions'));
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  useEffect(() => {
    const handleEsc = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEsc);
    void loadSessions();
    return () => window.removeEventListener('keydown', handleEsc);
  }, [loadSessions, onClose]);

  if (!user) return null;

  const selectSection = (next: SettingsSection) => {
    resetMessages();
    setSection(next);
  };

  const saveProfile = async (event: React.FormEvent) => {
    event.preventDefault();
    const normalizedAvatar = avatarUrl.trim();
    if (!username.trim() || (username.trim() === user.username && normalizedAvatar === (user.avatar_url || ''))) return;
    setSaving(true);
    resetMessages();
    try {
      await authApi.updateProfile({ username: username.trim(), avatar_url: normalizedAvatar });
      await refreshUser();
      setAvatarFailed(false);
      setSuccess('Profile updated.');
    } catch (saveError: unknown) {
      setError(errorMessage(saveError, 'Failed to update profile'));
    } finally {
      setSaving(false);
    }
  };

  const changePassword = async (event: React.FormEvent) => {
    event.preventDefault();
    resetMessages();
    if (newPassword.length < 12) {
      setError('New password must contain at least 12 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('New passwords do not match.');
      return;
    }
    setSaving(true);
    try {
      await authApi.changePassword({ current_password: currentPassword, new_password: newPassword });
      setSuccess('Password changed. Redirecting to sign in…');
      window.setTimeout(() => void logout(), 800);
    } catch (passwordError: unknown) {
      setError(errorMessage(passwordError, 'Failed to change password'));
    } finally {
      setSaving(false);
    }
  };

  const revokeSession = async (sessionId: string) => {
    setRevokingId(sessionId);
    resetMessages();
    try {
      await authApi.revokeSession(sessionId);
      setSessions((current) => current.filter((session) => session.id !== sessionId));
      setSuccess('Session revoked. Its access token may remain valid for up to 30 minutes.');
    } catch (revokeError: unknown) {
      setError(errorMessage(revokeError, 'Failed to revoke session'));
    } finally {
      setRevokingId(null);
    }
  };

  const revokeAllSessions = async () => {
    if (!window.confirm('Sign out every device, including this browser?')) return;
    setRevokingId('all');
    resetMessages();
    try {
      await authApi.revokeAllSessions();
      await logout();
    } catch (revokeError: unknown) {
      if (revokeError instanceof ApiError && revokeError.status === 401) {
        await logout();
        return;
      }
      setError(errorMessage(revokeError, 'Failed to revoke sessions'));
      setRevokingId(null);
    }
  };

  const sections: Array<{ id: SettingsSection; label: string; icon: typeof UserIcon }> = [
    { id: 'profile', label: 'Profile', icon: UserIcon },
    { id: 'security', label: 'Security', icon: ShieldCheck },
    { id: 'sessions', label: 'Sessions', icon: MonitorSmartphone },
  ];

  const storagePercent = user.storage_quota
    ? Math.min(100, (user.storage_used / user.storage_quota) * 100)
    : 0;
  const profileUnchanged = username.trim() === user.username
    && avatarUrl.trim() === (user.avatar_url || '');
  const initials = user.username.slice(0, 2).toUpperCase();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative flex max-h-[88vh] w-full max-w-4xl overflow-hidden rounded-3xl border border-gray-800 bg-gray-900 shadow-2xl">
        <aside className="hidden w-56 shrink-0 border-r border-gray-800 bg-gray-950/60 p-5 sm:block">
          <div className="mb-6">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-400">Account</p>
            <h2 className="mt-1 text-xl font-bold text-white">Settings</h2>
          </div>
          <div className="mb-5 flex items-center gap-3 rounded-xl border border-gray-800 bg-gray-900/70 p-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-cyan-500/15 text-sm font-semibold text-cyan-300">
              {user.avatar_url && !avatarFailed ? (
                // User-provided remote URLs cannot use the optimized image allowlist.
                // eslint-disable-next-line @next/next/no-img-element
                <img src={user.avatar_url} alt="" className="h-full w-full object-cover" onError={() => setAvatarFailed(true)} />
              ) : initials}
            </div>
            <div className="min-w-0"><p className="truncate text-sm font-medium text-white">{user.username}</p><p className="truncate text-xs text-gray-500">{user.email}</p></div>
          </div>
          <nav className="space-y-1">
            {sections.map((item) => {
              const Icon = item.icon;
              return (
                <button key={item.id} type="button" onClick={() => selectSection(item.id)} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors ${section === item.id ? 'bg-cyan-500/15 text-cyan-300' : 'text-gray-400 hover:bg-gray-800 hover:text-white'}`}>
                  <Icon size={17} /> {item.label}
                </button>
              );
            })}
          </nav>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
            <div><h2 className="text-lg font-semibold text-white sm:hidden">Account Settings</h2><p className="text-sm text-gray-400">Manage personal identity and sign-in security.</p></div>
            <button type="button" onClick={onClose} className="rounded-xl p-2 text-gray-400 hover:bg-gray-800 hover:text-white" aria-label="Close settings"><X size={20} /></button>
          </header>

          <div className="flex gap-2 overflow-x-auto border-b border-gray-800 px-4 py-3 sm:hidden">
            {sections.map((item) => <button key={item.id} type="button" onClick={() => selectSection(item.id)} className={`rounded-lg px-3 py-2 text-sm ${section === item.id ? 'bg-cyan-500/15 text-cyan-300' : 'text-gray-400'}`}>{item.label}</button>)}
          </div>

          <main className="overflow-y-auto p-6">
            {error && <div className="mb-5 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">{error}</div>}
            {success && <div className="mb-5 flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-300"><Check size={16} />{success}</div>}

            {section === 'profile' && (
              <form onSubmit={saveProfile} className="mx-auto max-w-2xl space-y-6">
                <div><h3 className="text-xl font-semibold text-white">Profile & account</h3><p className="mt-1 text-sm text-gray-500">Personal identity and storage are separate from project roles and quotas.</p></div>

                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="rounded-xl border border-gray-800 bg-gray-950/50 p-4"><div className="flex items-center gap-2 text-xs uppercase tracking-wide text-gray-500"><ShieldCheck size={15} /> Role</div><p className="mt-2 capitalize text-sm font-medium text-gray-200">{user.role}</p></div>
                  <div className="rounded-xl border border-gray-800 bg-gray-950/50 p-4"><div className="flex items-center gap-2 text-xs uppercase tracking-wide text-gray-500"><BadgeCheck size={15} /> Status</div><p className="mt-2 text-sm font-medium text-emerald-300">{user.is_active ? 'Active' : 'Disabled'}{user.is_verified ? ' · verified' : ''}</p></div>
                  <div className="rounded-xl border border-gray-800 bg-gray-950/50 p-4"><div className="flex items-center gap-2 text-xs uppercase tracking-wide text-gray-500"><CalendarDays size={15} /> Member since</div><p className="mt-2 text-sm font-medium text-gray-200">{new Date(user.created_at).toLocaleDateString()}</p></div>
                </div>

                <div className="grid gap-5 sm:grid-cols-[96px_1fr] sm:items-start">
                  <div className="flex h-24 w-24 items-center justify-center overflow-hidden rounded-2xl border border-gray-700 bg-cyan-500/10 text-2xl font-semibold text-cyan-300">
                    {avatarUrl && !avatarFailed ? (
                      // User-provided remote URLs cannot use the optimized image allowlist.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={avatarUrl} alt="Profile avatar preview" className="h-full w-full object-cover" onError={() => setAvatarFailed(true)} />
                    ) : initials}
                  </div>
                  <div className="space-y-4">
                    <label className="block text-sm text-gray-400">Username<input value={username} onChange={(event) => setUsername(event.target.value)} minLength={3} maxLength={100} required className="mt-2 w-full rounded-xl border border-gray-700 bg-gray-950 px-4 py-3 text-white outline-none focus:border-cyan-500/60 focus:ring-2 focus:ring-cyan-500/20" /></label>
                    <label className="block text-sm text-gray-400">Avatar URL<input type="url" value={avatarUrl} onChange={(event) => { setAvatarUrl(event.target.value); setAvatarFailed(false); }} maxLength={500} placeholder="https://example.com/avatar.jpg" className="mt-2 w-full rounded-xl border border-gray-700 bg-gray-950 px-4 py-3 text-white outline-none placeholder:text-gray-700 focus:border-cyan-500/60 focus:ring-2 focus:ring-cyan-500/20" /><span className="mt-1 block text-xs text-gray-600">Leave empty to use your initials.</span></label>
                  </div>
                </div>

                <label className="block text-sm text-gray-400">Email address<div className="mt-2 flex items-center gap-3 rounded-xl border border-gray-800 bg-gray-800/40 px-4 py-3 text-gray-500"><Mail size={17} /><span>{user.email}</span><span className="ml-auto text-xs">Managed by your sign-in identity</span></div></label>

                <div className="rounded-xl border border-cyan-500/20 bg-cyan-950/20 p-4">
                  <div className="flex items-start justify-between gap-4"><div><div className="flex items-center gap-2 text-sm font-medium text-gray-200"><HardDrive size={17} className="text-cyan-400" /> Personal storage</div><p className="mt-1 text-xs text-gray-500">Project storage is counted against each project quota separately.</p></div><span className="text-sm font-semibold text-cyan-300">{storagePercent.toFixed(1)}%</span></div>
                  <div className="my-3 h-2 overflow-hidden rounded-full bg-gray-800"><div className="h-full bg-gradient-to-r from-cyan-500 to-blue-500" style={{ width: `${storagePercent}%` }} /></div>
                  <div className="flex justify-between text-xs text-gray-400"><span>{formatBytes(user.storage_used)} used</span><span>{formatBytes(Math.max(0, user.storage_quota - user.storage_used))} available · {formatBytes(user.storage_quota)} total</span></div>
                </div>
                <div className="flex justify-end border-t border-gray-800 pt-5"><button disabled={saving || profileUnchanged} className="flex items-center gap-2 rounded-xl bg-cyan-500 px-5 py-2.5 font-semibold text-gray-950 disabled:cursor-not-allowed disabled:opacity-50">{saving ? <Loader2 size={17} className="animate-spin" /> : <Save size={17} />} Save profile</button></div>
              </form>
            )}

            {section === 'security' && (
              <form onSubmit={changePassword} className="mx-auto max-w-xl space-y-5">
                <div><h3 className="flex items-center gap-2 text-xl font-semibold text-white"><KeyRound className="text-cyan-400" size={21} />Change password</h3><p className="mt-1 text-sm text-gray-500">Changing it revokes every refresh session and requires signing in again.</p></div>
                <label className="block text-sm text-gray-400">Current password<input type="password" autoComplete="current-password" required value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} className="mt-2 w-full rounded-xl border border-gray-700 bg-gray-950 px-4 py-3 text-white outline-none focus:border-cyan-500/60" /></label>
                <label className="block text-sm text-gray-400">New password<input type="password" autoComplete="new-password" required minLength={12} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} className="mt-2 w-full rounded-xl border border-gray-700 bg-gray-950 px-4 py-3 text-white outline-none focus:border-cyan-500/60" /><span className="mt-1 block text-xs text-gray-600">At least 12 characters.</span></label>
                <label className="block text-sm text-gray-400">Confirm new password<input type="password" autoComplete="new-password" required minLength={12} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} className="mt-2 w-full rounded-xl border border-gray-700 bg-gray-950 px-4 py-3 text-white outline-none focus:border-cyan-500/60" /></label>
                <div className="flex justify-end border-t border-gray-800 pt-5"><button disabled={saving} className="flex items-center gap-2 rounded-xl bg-cyan-500 px-5 py-2.5 font-semibold text-gray-950 disabled:opacity-50">{saving ? <Loader2 size={17} className="animate-spin" /> : <KeyRound size={17} />} Change password</button></div>
              </form>
            )}

            {section === 'sessions' && (
              <div className="mx-auto max-w-2xl space-y-5">
                <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-xl font-semibold text-white">Active sessions</h3><p className="mt-1 text-sm text-gray-500">Refresh sessions that can issue new access tokens.</p></div><button type="button" onClick={revokeAllSessions} disabled={revokingId === 'all' || sessions.length === 0} className="flex items-center gap-2 rounded-xl border border-red-500/30 px-3 py-2 text-sm text-red-300 hover:bg-red-500/10 disabled:opacity-40">{revokingId === 'all' ? <Loader2 size={16} className="animate-spin" /> : <LogOut size={16} />} Sign out all</button></div>
                {sessionsLoading ? <div className="flex justify-center py-14 text-gray-500"><Loader2 className="animate-spin" /></div> : sessions.length === 0 ? <div className="rounded-xl border border-gray-800 bg-gray-950/50 p-8 text-center text-sm text-gray-500">No active refresh sessions.</div> : <div className="space-y-3">{sessions.map((session) => <div key={session.id} className="flex items-center gap-4 rounded-xl border border-gray-800 bg-gray-950/50 p-4"><div className="rounded-xl bg-gray-800 p-2.5 text-cyan-400"><MonitorSmartphone size={20} /></div><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium text-gray-200">{describeAgent(session.user_agent)}</p><p className="mt-1 text-xs text-gray-500">IP {session.ip_address || 'unknown'} · Created {new Date(session.created_at).toLocaleString()} · Expires {new Date(session.expires_at).toLocaleString()}</p></div><button type="button" onClick={() => revokeSession(session.id)} disabled={revokingId === session.id} className="rounded-lg p-2 text-gray-500 hover:bg-red-500/10 hover:text-red-300" aria-label="Revoke session">{revokingId === session.id ? <Loader2 size={17} className="animate-spin" /> : <Trash2 size={17} />}</button></div>)}</div>}
                <p className="text-xs leading-5 text-gray-600">Revoking a refresh session prevents renewal. An access token already issued from it can remain valid until its short expiry window ends.</p>
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
