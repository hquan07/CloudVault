import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  BadgeCheck,
  BellRing,
  CalendarDays,
  Check,
  CircleCheck,
  Clock3,
  Database,
  Download,
  HardDrive,
  KeyRound,
  Loader2,
  LogOut,
  Mail,
  MonitorSmartphone,
  RefreshCw,
  Save,
  SearchX,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  User as UserIcon,
  X,
} from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { ApiError, AuthSession, SecurityEvent, authApi } from '@/lib/api';
import { formatBytes } from '@/lib/utils';
import {
  AccountPreferences,
  loadPreferences,
  savePreferences,
} from '@/lib/preferences';

interface SettingsModalProps {
  onClose: () => void;
}

type SettingsSection = 'profile' | 'security' | 'sessions' | 'preferences' | 'privacy';

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

function securityActionLabel(action: string) {
  const labels: Record<string, string> = {
    USER_REGISTERED: 'Account registered',
    USER_LOGGED_IN: 'Signed in',
    USER_LOGIN_FAILED: 'Sign-in attempt failed',
    USER_LOGGED_OUT: 'Signed out',
    PASSWORD_CHANGED: 'Password changed',
    SESSION_REVOKED: 'Session revoked',
    SESSIONS_REVOKED: 'All sessions revoked',
    REFRESH_TOKEN_REPLAYED: 'Suspicious session replay blocked',
    MFA_ENABLED: 'Multi-factor authentication enabled',
    MFA_DISABLED: 'Multi-factor authentication disabled',
    MFA_RECOVERY_USED: 'Recovery code used',
  };
  return labels[action] || action.replaceAll('_', ' ').toLowerCase();
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
  const [securityEvents, setSecurityEvents] = useState<SecurityEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [preferences, setPreferenceState] = useState<AccountPreferences>(() => loadPreferences());
  const [notificationPermission, setNotificationPermission] = useState<string>(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
    return Notification.permission;
  });
  const [mfaPassword, setMfaPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [mfaSetup, setMfaSetup] = useState<{ secret: string; otpauth_uri: string } | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [mfaBusy, setMfaBusy] = useState(false);

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

  const loadSecurityEvents = useCallback(async () => {
    setEventsLoading(true);
    try {
      setSecurityEvents(await authApi.listSecurityEvents());
    } catch (loadError: unknown) {
      setError(errorMessage(loadError, 'Failed to load security activity'));
    } finally {
      setEventsLoading(false);
    }
  }, []);

  useEffect(() => {
    const handleEsc = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEsc);
    void Promise.all([loadSessions(), loadSecurityEvents()]);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [loadSecurityEvents, loadSessions, onClose]);

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

  const revokeSession = async (session: AuthSession) => {
    const warning = session.is_current
      ? 'Sign out this browser? You will need to sign in again.'
      : `Revoke the ${describeAgent(session.user_agent)} session?`;
    if (!window.confirm(warning)) return;
    setRevokingId(session.id);
    resetMessages();
    try {
      await authApi.revokeSession(session.id);
      if (session.is_current) {
        await logout();
        return;
      }
      setSessions((current) => current.filter((item) => item.id !== session.id));
      setSuccess('Session revoked. Its access token may remain valid for up to 30 minutes.');
      void loadSecurityEvents();
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

  const updatePreference = (key: keyof AccountPreferences, value: boolean) => {
    const updated = { ...preferences, [key]: value };
    setPreferenceState(updated);
    savePreferences(updated);
    resetMessages();
    setSuccess('Preferences saved on this browser.');
  };

  const toggleBrowserNotifications = async () => {
    resetMessages();
    if (!('Notification' in window)) {
      setError('This browser does not support desktop notifications.');
      return;
    }
    if (!preferences.browserNotifications) {
      const permission = await Notification.requestPermission();
      setNotificationPermission(permission);
      if (permission !== 'granted') {
        setError(permission === 'denied'
          ? 'Desktop notifications are blocked in your browser settings.'
          : 'Desktop notification permission was not granted.');
        return;
      }
    }
    updatePreference('browserNotifications', !preferences.browserNotifications);
  };

  const downloadAccountData = () => {
    const exported = {
      exported_at: new Date().toISOString(),
      profile: user,
      active_sessions: sessions,
      recent_security_activity: securityEvents,
      browser_preferences: preferences,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `cloudvault-account-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    resetMessages();
    setSuccess('Account information downloaded. File contents exclude passwords and tokens.');
  };

  const clearRecentSearches = () => {
    localStorage.removeItem('cloudvault_recent_searches');
    resetMessages();
    setSuccess('Recent searches cleared from this browser.');
  };

  const beginMfaSetup = async () => {
    resetMessages();
    setMfaBusy(true);
    try {
      setMfaSetup(await authApi.setupMfa(mfaPassword));
      setMfaCode('');
      setSuccess('Authenticator secret created. Verify one code to finish setup.');
    } catch (setupError: unknown) {
      setError(errorMessage(setupError, 'Failed to start MFA setup'));
    } finally {
      setMfaBusy(false);
    }
  };

  const enableMfa = async () => {
    resetMessages();
    setMfaBusy(true);
    try {
      const result = await authApi.enableMfa(mfaCode);
      setRecoveryCodes(result.recovery_codes);
      setMfaSetup(null);
      setMfaPassword('');
      setMfaCode('');
      await refreshUser();
      setSuccess('Multi-factor authentication enabled. Save the recovery codes now.');
      void loadSecurityEvents();
    } catch (enableError: unknown) {
      setError(errorMessage(enableError, 'Failed to enable MFA'));
    } finally {
      setMfaBusy(false);
    }
  };

  const disableMfa = async () => {
    if (!window.confirm('Disable multi-factor authentication and sign out every device?')) return;
    resetMessages();
    setMfaBusy(true);
    try {
      await authApi.disableMfa(mfaPassword, mfaCode);
      await logout();
    } catch (disableError: unknown) {
      setError(errorMessage(disableError, 'Failed to disable MFA'));
      setMfaBusy(false);
    }
  };

  const downloadRecoveryCodes = () => {
    const contents = `CloudVault MFA recovery codes\nGenerated: ${new Date().toISOString()}\n\n${recoveryCodes.join('\n')}\n`;
    const url = URL.createObjectURL(new Blob([contents], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'cloudvault-recovery-codes.txt';
    link.click();
    URL.revokeObjectURL(url);
  };

  const sections: Array<{ id: SettingsSection; label: string; icon: typeof UserIcon }> = [
    { id: 'profile', label: 'Profile', icon: UserIcon },
    { id: 'security', label: 'Security', icon: ShieldCheck },
    { id: 'sessions', label: 'Sessions', icon: MonitorSmartphone },
    { id: 'preferences', label: 'Preferences', icon: SlidersHorizontal },
    { id: 'privacy', label: 'Privacy & data', icon: Database },
  ];

  const storagePercent = user.storage_quota
    ? Math.min(100, (user.storage_used / user.storage_quota) * 100)
    : 0;
  const profileUnchanged = username.trim() === user.username
    && avatarUrl.trim() === (user.avatar_url || '');
  const initials = user.username.slice(0, 2).toUpperCase();
  const passwordRules = [
    { label: 'At least 12 characters', met: newPassword.length >= 12 },
    { label: 'Contains an uppercase letter', met: /[A-Z]/.test(newPassword) },
    { label: 'Contains a lowercase letter', met: /[a-z]/.test(newPassword) },
    { label: 'Contains a number or symbol', met: /[^A-Za-z]/.test(newPassword) },
  ];

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
              <div className="mx-auto max-w-2xl space-y-6">
                <div><h3 className="text-xl font-semibold text-white">Sign-in security</h3><p className="mt-1 text-sm text-gray-500">Review your account protection and recent security activity.</p></div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="rounded-xl border border-gray-800 bg-gray-950/50 p-4"><div className="flex items-center gap-2 text-xs uppercase tracking-wide text-gray-500"><BadgeCheck size={15} /> Identity</div><p className="mt-2 text-sm font-medium text-emerald-300">{user.is_verified ? 'Verified' : 'Not verified'}</p></div>
                  <div className="rounded-xl border border-gray-800 bg-gray-950/50 p-4"><div className="flex items-center gap-2 text-xs uppercase tracking-wide text-gray-500"><KeyRound size={15} /> Sign-in method</div><p className="mt-2 capitalize text-sm font-medium text-gray-200">{user.oauth_provider}</p></div>
                  <div className="rounded-xl border border-gray-800 bg-gray-950/50 p-4"><div className="flex items-center gap-2 text-xs uppercase tracking-wide text-gray-500"><Clock3 size={15} /> Last sign-in</div><p className="mt-2 text-sm font-medium text-gray-200">{user.last_login_at ? new Date(user.last_login_at).toLocaleString() : 'Not recorded'}</p></div>
                </div>

                <section className={`rounded-2xl border p-5 ${user.mfa_enabled ? 'border-emerald-500/25 bg-emerald-950/10' : 'border-gray-800 bg-gray-950/35'}`}>
                  <div className="flex items-start gap-3"><div className={`rounded-xl p-2.5 ${user.mfa_enabled ? 'bg-emerald-500/10 text-emerald-300' : 'bg-gray-800 text-cyan-400'}`}><ShieldCheck size={20} /></div><div><h4 className="font-semibold text-white">Authenticator app (TOTP)</h4><p className="mt-1 text-sm text-gray-500">{user.mfa_enabled ? 'A time-based authentication code is required when you sign in.' : 'Add a second sign-in factor compatible with common authenticator apps.'}</p></div><span className={`ml-auto rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide ${user.mfa_enabled ? 'bg-emerald-500/10 text-emerald-300' : 'bg-gray-800 text-gray-500'}`}>{user.mfa_enabled ? 'Enabled' : 'Disabled'}</span></div>

                  {recoveryCodes.length > 0 && (
                    <div className="mt-5 rounded-xl border border-amber-500/25 bg-amber-500/5 p-4"><p className="text-sm font-medium text-amber-200">Save these recovery codes now</p><p className="mt-1 text-xs text-gray-500">Each code works once. CloudVault stores only hashes and cannot show them again.</p><div className="mt-3 grid grid-cols-2 gap-2 rounded-lg bg-gray-950 p-3 font-mono text-sm text-gray-300 sm:grid-cols-4">{recoveryCodes.map((code) => <span key={code}>{code}</span>)}</div><button type="button" onClick={downloadRecoveryCodes} className="mt-3 flex items-center gap-2 rounded-lg border border-amber-500/25 px-3 py-2 text-xs font-medium text-amber-200 hover:bg-amber-500/10"><Download size={15} /> Download codes</button></div>
                  )}

                  {!user.mfa_enabled && !mfaSetup && recoveryCodes.length === 0 && (
                    <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-end"><label className="min-w-0 flex-1 text-sm text-gray-400">Current password<input type="password" autoComplete="current-password" value={mfaPassword} onChange={(event) => setMfaPassword(event.target.value)} className="mt-2 w-full rounded-xl border border-gray-700 bg-gray-950 px-4 py-3 text-white outline-none focus:border-cyan-500/60" /></label><button type="button" onClick={() => void beginMfaSetup()} disabled={mfaBusy || !mfaPassword} className="flex h-12 shrink-0 items-center justify-center gap-2 rounded-xl bg-cyan-500 px-4 font-semibold text-gray-950 disabled:opacity-50">{mfaBusy ? <Loader2 size={17} className="animate-spin" /> : <ShieldCheck size={17} />} Set up MFA</button></div>
                  )}

                  {!user.mfa_enabled && mfaSetup && (
                    <div className="mt-5 space-y-4"><div className="rounded-xl border border-cyan-500/20 bg-cyan-950/15 p-4"><p className="text-sm text-gray-300">Add this setup key to your authenticator app:</p><code className="mt-2 block break-all rounded-lg bg-gray-950 p-3 font-mono text-sm tracking-widest text-cyan-200">{mfaSetup.secret}</code><a href={mfaSetup.otpauth_uri} className="mt-2 inline-block text-xs text-cyan-400 hover:text-cyan-300">Open in an authenticator app</a></div><div className="flex flex-col gap-3 sm:flex-row sm:items-end"><label className="min-w-0 flex-1 text-sm text-gray-400">Six-digit code<input type="text" inputMode="numeric" autoComplete="one-time-code" value={mfaCode} onChange={(event) => setMfaCode(event.target.value.trim())} maxLength={6} className="mt-2 w-full rounded-xl border border-gray-700 bg-gray-950 px-4 py-3 font-mono tracking-[0.3em] text-white outline-none focus:border-cyan-500/60" /></label><button type="button" onClick={() => void enableMfa()} disabled={mfaBusy || mfaCode.length !== 6} className="flex h-12 shrink-0 items-center justify-center gap-2 rounded-xl bg-cyan-500 px-4 font-semibold text-gray-950 disabled:opacity-50">{mfaBusy ? <Loader2 size={17} className="animate-spin" /> : <BadgeCheck size={17} />} Verify & enable</button></div></div>
                  )}

                  {user.mfa_enabled && recoveryCodes.length === 0 && (
                    <div className="mt-5 grid gap-3 sm:grid-cols-2"><label className="text-sm text-gray-400">Current password<input type="password" autoComplete="current-password" value={mfaPassword} onChange={(event) => setMfaPassword(event.target.value)} className="mt-2 w-full rounded-xl border border-gray-700 bg-gray-950 px-4 py-3 text-white outline-none focus:border-red-500/50" /></label><label className="text-sm text-gray-400">Authenticator or recovery code<input type="text" autoComplete="one-time-code" value={mfaCode} onChange={(event) => setMfaCode(event.target.value.trim())} className="mt-2 w-full rounded-xl border border-gray-700 bg-gray-950 px-4 py-3 font-mono text-white outline-none focus:border-red-500/50" /></label><div className="sm:col-span-2"><button type="button" onClick={() => void disableMfa()} disabled={mfaBusy || !mfaPassword || mfaCode.length < 6} className="flex items-center gap-2 rounded-xl border border-red-500/30 px-4 py-2.5 text-sm font-medium text-red-300 hover:bg-red-500/10 disabled:opacity-50">{mfaBusy ? <Loader2 size={16} className="animate-spin" /> : <ShieldAlert size={16} />} Disable MFA</button></div></div>
                  )}
                </section>

                <form onSubmit={changePassword} className="space-y-5 rounded-2xl border border-gray-800 bg-gray-950/35 p-5">
                  <div><h4 className="flex items-center gap-2 font-semibold text-white"><KeyRound className="text-cyan-400" size={19} />Change password</h4><p className="mt-1 text-sm text-gray-500">Changing it revokes every refresh session and requires signing in again.</p></div>
                  <label className="block text-sm text-gray-400">Current password<input type="password" autoComplete="current-password" required value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} className="mt-2 w-full rounded-xl border border-gray-700 bg-gray-950 px-4 py-3 text-white outline-none focus:border-cyan-500/60" /></label>
                  <label className="block text-sm text-gray-400">New password<input type="password" autoComplete="new-password" required minLength={12} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} className="mt-2 w-full rounded-xl border border-gray-700 bg-gray-950 px-4 py-3 text-white outline-none focus:border-cyan-500/60" /></label>
                  <div className="grid gap-2 text-xs sm:grid-cols-2">{passwordRules.map((rule) => <div key={rule.label} className={`flex items-center gap-2 ${rule.met ? 'text-emerald-300' : 'text-gray-600'}`}><CircleCheck size={14} /> {rule.label}</div>)}</div>
                  <label className="block text-sm text-gray-400">Confirm new password<input type="password" autoComplete="new-password" required minLength={12} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} className="mt-2 w-full rounded-xl border border-gray-700 bg-gray-950 px-4 py-3 text-white outline-none focus:border-cyan-500/60" /></label>
                  <div className="flex justify-end border-t border-gray-800 pt-5"><button disabled={saving || passwordRules.some((rule) => !rule.met) || newPassword !== confirmPassword} className="flex items-center gap-2 rounded-xl bg-cyan-500 px-5 py-2.5 font-semibold text-gray-950 disabled:opacity-50">{saving ? <Loader2 size={17} className="animate-spin" /> : <KeyRound size={17} />} Change password</button></div>
                </form>

                <div className="rounded-2xl border border-gray-800 bg-gray-950/35 p-5">
                  <div className="mb-4 flex items-center justify-between gap-3"><div><h4 className="flex items-center gap-2 font-semibold text-white"><Activity size={18} className="text-cyan-400" />Recent security activity</h4><p className="mt-1 text-sm text-gray-500">The latest sign-in, password and session events for your account.</p></div><button type="button" onClick={() => void loadSecurityEvents()} disabled={eventsLoading} className="rounded-lg p-2 text-gray-500 hover:bg-gray-800 hover:text-cyan-300" aria-label="Refresh security activity"><RefreshCw size={17} className={eventsLoading ? 'animate-spin' : ''} /></button></div>
                  {eventsLoading ? <div className="flex justify-center py-8 text-gray-500"><Loader2 className="animate-spin" /></div> : securityEvents.length === 0 ? <p className="py-6 text-center text-sm text-gray-600">No security events recorded yet.</p> : <div className="divide-y divide-gray-800">{securityEvents.slice(0, 8).map((event) => <div key={event.id} className="flex items-start gap-3 py-3"><div className={`mt-0.5 rounded-lg p-2 ${event.action.includes('FAILED') || event.action.includes('REPLAYED') ? 'bg-red-500/10 text-red-300' : 'bg-emerald-500/10 text-emerald-300'}`}>{event.action.includes('FAILED') || event.action.includes('REPLAYED') ? <ShieldAlert size={16} /> : <ShieldCheck size={16} />}</div><div className="min-w-0 flex-1"><p className="text-sm text-gray-200">{securityActionLabel(event.action)}</p><p className="mt-1 truncate text-xs text-gray-600">{describeAgent(event.user_agent)} · IP {event.ip_address || 'unknown'}</p></div><time className="shrink-0 text-xs text-gray-600">{new Date(event.created_at).toLocaleString()}</time></div>)}</div>}
                </div>
              </div>
            )}

            {section === 'sessions' && (
              <div className="mx-auto max-w-2xl space-y-5">
                <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-xl font-semibold text-white">Active sessions</h3><p className="mt-1 text-sm text-gray-500">Devices that can renew access to your account.</p></div><div className="flex gap-2"><button type="button" onClick={() => void loadSessions()} disabled={sessionsLoading} className="rounded-xl border border-gray-700 p-2 text-gray-400 hover:border-cyan-500/40 hover:text-cyan-300" aria-label="Refresh sessions"><RefreshCw size={17} className={sessionsLoading ? 'animate-spin' : ''} /></button><button type="button" onClick={revokeAllSessions} disabled={revokingId === 'all' || sessions.length === 0} className="flex items-center gap-2 rounded-xl border border-red-500/30 px-3 py-2 text-sm text-red-300 hover:bg-red-500/10 disabled:opacity-40">{revokingId === 'all' ? <Loader2 size={16} className="animate-spin" /> : <LogOut size={16} />} Sign out all</button></div></div>
                {sessionsLoading ? <div className="flex justify-center py-14 text-gray-500"><Loader2 className="animate-spin" /></div> : sessions.length === 0 ? <div className="rounded-xl border border-gray-800 bg-gray-950/50 p-8 text-center text-sm text-gray-500">No active refresh sessions.</div> : <div className="space-y-3">{sessions.map((session) => <div key={session.id} className={`flex items-center gap-4 rounded-xl border p-4 ${session.is_current ? 'border-cyan-500/30 bg-cyan-950/15' : 'border-gray-800 bg-gray-950/50'}`}><div className="rounded-xl bg-gray-800 p-2.5 text-cyan-400"><MonitorSmartphone size={20} /></div><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><p className="truncate text-sm font-medium text-gray-200">{describeAgent(session.user_agent)}</p>{session.is_current && <span className="rounded-full bg-cyan-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-cyan-300">This device</span>}</div><p className="mt-1 text-xs text-gray-500">IP {session.ip_address || 'unknown'} · Last active {new Date(session.last_active_at).toLocaleString()}</p><p className="mt-1 text-xs text-gray-600">Signed in {new Date(session.session_started_at).toLocaleString()} · Expires {new Date(session.expires_at).toLocaleString()}</p></div><button type="button" onClick={() => void revokeSession(session)} disabled={revokingId === session.id} className="rounded-lg p-2 text-gray-500 hover:bg-red-500/10 hover:text-red-300" aria-label={session.is_current ? 'Sign out this device' : 'Revoke session'}>{revokingId === session.id ? <Loader2 size={17} className="animate-spin" /> : session.is_current ? <LogOut size={17} /> : <Trash2 size={17} />}</button></div>)}</div>}
                <p className="text-xs leading-5 text-gray-600">Revoking a refresh session prevents renewal. An access token already issued from it can remain valid until its short expiry window ends.</p>
              </div>
            )}

            {section === 'preferences' && (
              <div className="mx-auto max-w-2xl space-y-6">
                <div><h3 className="text-xl font-semibold text-white">Preferences</h3><p className="mt-1 text-sm text-gray-500">These choices are stored locally and apply only to this browser.</p></div>

                <section className="overflow-hidden rounded-2xl border border-gray-800 bg-gray-950/35">
                  <div className="border-b border-gray-800 p-5"><h4 className="flex items-center gap-2 font-semibold text-white"><BellRing size={18} className="text-cyan-400" />Notifications</h4><p className="mt-1 text-sm text-gray-500">Control how live project and file activity reaches you.</p></div>
                  <div className="divide-y divide-gray-800">
                    <div className="flex items-center justify-between gap-5 p-5"><div><p className="text-sm font-medium text-gray-200">In-app activity alerts</p><p className="mt-1 text-xs text-gray-500">Show temporary alerts while CloudVault is open.</p></div><button type="button" role="switch" aria-checked={preferences.inAppNotifications} onClick={() => updatePreference('inAppNotifications', !preferences.inAppNotifications)} className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${preferences.inAppNotifications ? 'bg-cyan-500' : 'bg-gray-700'}`}><span className={`absolute top-1 h-4 w-4 rounded-full bg-white transition-transform ${preferences.inAppNotifications ? 'left-6' : 'left-1'}`} /></button></div>
                    <div className="flex items-center justify-between gap-5 p-5"><div><p className="text-sm font-medium text-gray-200">Desktop notifications</p><p className="mt-1 text-xs text-gray-500">Use browser notifications when permission is granted. Current permission: <span className="text-gray-400">{notificationPermission}</span>.</p></div><button type="button" role="switch" aria-checked={preferences.browserNotifications} onClick={() => void toggleBrowserNotifications()} disabled={notificationPermission === 'unsupported'} className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-40 ${preferences.browserNotifications ? 'bg-cyan-500' : 'bg-gray-700'}`}><span className={`absolute top-1 h-4 w-4 rounded-full bg-white transition-transform ${preferences.browserNotifications ? 'left-6' : 'left-1'}`} /></button></div>
                  </div>
                </section>

                <section className="overflow-hidden rounded-2xl border border-gray-800 bg-gray-950/35">
                  <div className="border-b border-gray-800 p-5"><h4 className="flex items-center gap-2 font-semibold text-white"><SlidersHorizontal size={18} className="text-cyan-400" />Interface</h4><p className="mt-1 text-sm text-gray-500">Adjust density and motion without changing project data.</p></div>
                  <div className="divide-y divide-gray-800">
                    <div className="flex items-center justify-between gap-5 p-5"><div><p className="text-sm font-medium text-gray-200">Compact navigation</p><p className="mt-1 text-xs text-gray-500">Reduce spacing between sidebar destinations.</p></div><button type="button" role="switch" aria-checked={preferences.compactNavigation} onClick={() => updatePreference('compactNavigation', !preferences.compactNavigation)} className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${preferences.compactNavigation ? 'bg-cyan-500' : 'bg-gray-700'}`}><span className={`absolute top-1 h-4 w-4 rounded-full bg-white transition-transform ${preferences.compactNavigation ? 'left-6' : 'left-1'}`} /></button></div>
                    <div className="flex items-center justify-between gap-5 p-5"><div><p className="text-sm font-medium text-gray-200">Reduce motion</p><p className="mt-1 text-xs text-gray-500">Minimize animations and transitions for accessibility.</p></div><button type="button" role="switch" aria-checked={preferences.reduceMotion} onClick={() => updatePreference('reduceMotion', !preferences.reduceMotion)} className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${preferences.reduceMotion ? 'bg-cyan-500' : 'bg-gray-700'}`}><span className={`absolute top-1 h-4 w-4 rounded-full bg-white transition-transform ${preferences.reduceMotion ? 'left-6' : 'left-1'}`} /></button></div>
                  </div>
                </section>
              </div>
            )}

            {section === 'privacy' && (
              <div className="mx-auto max-w-2xl space-y-6">
                <div><h3 className="text-xl font-semibold text-white">Privacy & data</h3><p className="mt-1 text-sm text-gray-500">Review portable account information and browser-local data.</p></div>
                <div className="rounded-2xl border border-gray-800 bg-gray-950/35 p-5"><div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"><div><h4 className="flex items-center gap-2 font-semibold text-white"><Download size={18} className="text-cyan-400" />Download account information</h4><p className="mt-1 max-w-lg text-sm text-gray-500">Export your profile, active-session metadata, recent security activity and browser preferences as JSON. Passwords and tokens are never included.</p></div><button type="button" onClick={downloadAccountData} className="shrink-0 rounded-xl border border-cyan-500/30 px-4 py-2 text-sm font-medium text-cyan-300 hover:bg-cyan-500/10">Download JSON</button></div></div>
                <div className="rounded-2xl border border-gray-800 bg-gray-950/35 p-5"><div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"><div><h4 className="flex items-center gap-2 font-semibold text-white"><SearchX size={18} className="text-cyan-400" />Recent searches</h4><p className="mt-1 max-w-lg text-sm text-gray-500">Search history is stored only in this browser and is not part of project audit logs.</p></div><button type="button" onClick={clearRecentSearches} className="shrink-0 rounded-xl border border-gray-700 px-4 py-2 text-sm text-gray-300 hover:border-cyan-500/30 hover:text-cyan-300">Clear history</button></div></div>
                <div className="rounded-2xl border border-red-500/20 bg-red-950/10 p-5"><h4 className="font-semibold text-red-200">Account access</h4><p className="mt-1 text-sm text-gray-500">Immediately revoke every refresh session, including this browser. Existing access tokens are blacklisted for this request and otherwise expire within their short lifetime.</p><button type="button" onClick={revokeAllSessions} disabled={revokingId === 'all'} className="mt-4 flex items-center gap-2 rounded-xl border border-red-500/30 px-4 py-2 text-sm font-medium text-red-300 hover:bg-red-500/10 disabled:opacity-50">{revokingId === 'all' ? <Loader2 size={16} className="animate-spin" /> : <LogOut size={16} />} Sign out all devices</button></div>
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
