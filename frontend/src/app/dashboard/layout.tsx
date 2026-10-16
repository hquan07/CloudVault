'use client';

import { type DragEvent, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import { Cloud, Folder, Clock, Star, Trash2, Settings, LogOut, Search, Menu, Shield, Network, PieChart, Users, Activity, FolderKanban, X, BarChart3 } from 'lucide-react';
import { formatBytes } from '@/lib/utils';
import { SettingsModal } from '@/components/SettingsModal';
import {
  endTrashDrag,
  PERSONAL_DRAG_TYPE,
  PROJECT_DRAG_TYPE,
  readTrashDropPayload,
  TRASH_DROP_EVENT,
} from '@/lib/drag-to-trash';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { user, loading, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [showSettings, setShowSettings] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [trashDropActive, setTrashDropActive] = useState(false);
  const mobileCloseRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!loading && !user) {
      router.push('/');
    }
  }, [user, loading, router]);

  useEffect(() => {
    setAvatarFailed(false);
  }, [user?.avatar_url]);

  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!mobileNavOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    mobileCloseRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileNavOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [mobileNavOpen]);

  if (loading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-950 text-white">
        <div className="animate-pulse flex items-center space-x-2">
          <Cloud className="w-8 h-8 text-cyan-400" />
          <span className="text-xl font-medium">Loading...</span>
        </div>
      </div>
    );
  }

  const navItems = [
    { name: 'My Files', path: '/dashboard', icon: Folder },
    { name: 'Projects', path: '/dashboard/projects', icon: FolderKanban },
    { name: 'Shared with me', path: '/dashboard/shared-with-me', icon: Users },
    { name: 'Recent', path: '/dashboard/recent', icon: Clock },
    { name: 'Starred', path: '/dashboard/starred', icon: Star },
    { name: 'Activity Log', path: '/dashboard/activity', icon: Activity },
    { name: 'Analytics', path: '/dashboard/analytics', icon: BarChart3 },
    { name: 'Trash', path: '/dashboard/trash', icon: Trash2 },
  ];

  if (user?.role === 'admin') {
    navItems.push({ name: 'Architecture', path: '/dashboard/architecture', icon: Network });
    navItems.push({ name: 'Admin Panel', path: '/dashboard/admin', icon: Shield });
    navItems.push({ name: 'Admin Stats', path: '/dashboard/admin/stats', icon: PieChart });
  }

  const usagePercent = Math.min(100, (user.storage_used / user.storage_quota) * 100);

  const isCloudVaultDrag = (event: DragEvent) => Boolean(
    readTrashDropPayload(event.dataTransfer)
    || event.dataTransfer.types.includes(PERSONAL_DRAG_TYPE)
    || event.dataTransfer.types.includes(PROJECT_DRAG_TYPE)
  );

  const handleTrashDragOver = (event: DragEvent) => {
    if (!isCloudVaultDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    setTrashDropActive(true);
  };

  const handleTrashDrop = (event: DragEvent) => {
    if (!isCloudVaultDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setTrashDropActive(false);
    const payload = readTrashDropPayload(event.dataTransfer);
    if (payload) {
      window.dispatchEvent(new CustomEvent(TRASH_DROP_EVENT, { detail: payload }));
      endTrashDrag();
    }
  };

  const renderSidebarContent = (mobile = false) => (
    <>
      <div className="flex h-16 items-center justify-between border-b border-gray-800 px-6">
        <div className="flex items-center space-x-2 text-cyan-400">
          <Cloud size={28} />
          <span className="text-xl font-bold tracking-tight text-white">CloudVault</span>
        </div>
        {mobile && (
          <button
            ref={mobileCloseRef}
            type="button"
            onClick={() => setMobileNavOpen(false)}
            className="rounded-lg p-2 text-gray-400 hover:bg-gray-800 hover:text-white"
            aria-label="Close navigation"
          >
            <X size={20} />
          </button>
        )}
      </div>

      <nav className="flex-1 space-y-1.5 overflow-y-auto px-4 py-6" aria-label="Dashboard navigation">
        {navItems.map((item) => {
          const isActive = pathname === item.path || (
            item.path !== '/dashboard' && pathname.startsWith(`${item.path}/`)
          );
          const Icon = item.icon;
          const itemClassName = `flex w-full items-center space-x-3 rounded-xl px-4 py-3 text-left transition-all duration-200 ${
            item.name === 'Trash' && trashDropActive
              ? 'scale-[1.02] border border-red-400 bg-red-500/20 font-medium text-red-300 shadow-lg shadow-red-950/30'
              : isActive
              ? 'bg-cyan-500/10 font-medium text-cyan-400'
              : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
          }`;
          const itemContent = (
            <>
              <Icon size={20} className={item.name === 'Trash' && trashDropActive ? 'text-red-300' : isActive ? 'text-cyan-400' : 'text-gray-500'} />
              <span>{item.name}</span>
              {item.name === 'Trash' && trashDropActive && <span className="ml-auto text-[10px] uppercase tracking-wide">Drop</span>}
            </>
          );
          if (item.name === 'Trash') {
            return (
              <button
                key={item.name}
                type="button"
                aria-current={isActive ? 'page' : undefined}
                onClick={() => router.push(item.path)}
                onDragEnter={handleTrashDragOver}
                onDragOver={handleTrashDragOver}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node)) setTrashDropActive(false);
                }}
                onDropCapture={handleTrashDrop}
                className={itemClassName}
              >
                {itemContent}
              </button>
            );
          }
          return (
            <Link
              key={item.name}
              href={item.path}
              aria-current={isActive ? 'page' : undefined}
              className={itemClassName}
            >
              {itemContent}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-gray-800 p-6">
        <div className="mb-4">
          <div className="mb-1.5 flex justify-between text-xs text-gray-400">
            <span>Storage</span>
            <span>{Math.round(usagePercent)}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-gray-800">
            <div
              className={`h-full rounded-full transition-all duration-500 ${usagePercent > 90 ? 'bg-red-500' : 'bg-cyan-500'}`}
              style={{ width: `${usagePercent}%` }}
            />
          </div>
          <div className="mt-2 text-[11px] font-medium text-gray-500">
            {formatBytes(user.storage_used)} of {formatBytes(user.storage_quota)} used
          </div>
        </div>

        <div className="rounded-xl bg-gray-800/50 p-3">
          <div className="flex items-center space-x-3 overflow-hidden">
            <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-tr from-cyan-500 to-blue-500 text-sm font-bold uppercase text-white">
              {user.avatar_url && !avatarFailed ? (
                // User-provided remote URLs cannot use the optimized image allowlist.
                // eslint-disable-next-line @next/next/no-img-element
                <img src={user.avatar_url} alt="" className="h-full w-full rounded-full object-cover" onError={() => setAvatarFailed(true)} />
              ) : user.username.charAt(0)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{user.username}</div>
              <div className="truncate text-xs text-gray-400">{user.email}</div>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => { setMobileNavOpen(false); setShowSettings(true); }}
              className="inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs text-gray-300 hover:bg-gray-700 hover:text-white"
            >
              <Settings size={15} /> Settings
            </button>
            <button
              type="button"
              onClick={logout}
              className="inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs text-gray-300 hover:bg-red-400/10 hover:text-red-300"
            >
              <LogOut size={15} /> Log out
            </button>
          </div>
        </div>
      </div>
    </>
  );

  return (
    <div className="cloudvault-dashboard flex h-screen bg-gray-950 text-gray-100 overflow-hidden font-sans">
      {/* Sidebar */}
      <aside className="cloudvault-sidebar w-64 bg-gray-900 border-r border-gray-800 flex flex-col hidden md:flex z-20 shadow-xl">
        {renderSidebarContent()}
      </aside>

      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            onClick={() => setMobileNavOpen(false)}
            aria-label="Close navigation"
          />
          <aside
            id="mobile-dashboard-navigation"
            role="dialog"
            aria-modal="true"
            aria-label="Dashboard navigation"
            className="cloudvault-sidebar relative flex h-full w-[min(20rem,88vw)] flex-col border-r border-gray-800 bg-gray-900 shadow-2xl"
          >
            {renderSidebarContent(true)}
          </aside>
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-16 bg-gray-900/50 backdrop-blur-md border-b border-gray-800 flex items-center px-6 z-10 relative">
          <div className="flex items-center w-1/3">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              className="rounded-lg p-2 text-gray-400 hover:bg-gray-800 md:hidden"
              aria-label="Open navigation"
              aria-controls="mobile-dashboard-navigation"
              aria-expanded={mobileNavOpen}
            >
              <Menu size={20} />
            </button>
          </div>

          <div className="flex-1 flex justify-center">
            <div className="relative w-full max-w-xl hidden sm:block group">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-gray-500 group-focus-within:text-cyan-400 transition-colors">
                <Search size={16} />
              </div>
              <input 
                type="text" 
                placeholder="Search in CloudVault..." 
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.currentTarget.value.trim()) {
                    router.push(`/dashboard/search?q=${encodeURIComponent(e.currentTarget.value.trim())}`);
                  }
                }}
                className="w-full bg-gray-800/50 border border-gray-700/50 rounded-xl pl-10 pr-4 py-2 text-sm text-gray-200 focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500/50 transition-all placeholder:text-gray-500"
              />
            </div>
          </div>
          
          <div className="flex items-center justify-end space-x-4 w-1/3">
            <button 
              onClick={() => setShowSettings(true)}
              className="p-2 text-gray-400 hover:bg-gray-800 hover:text-gray-200 rounded-lg transition-colors"
              title="Account settings"
              aria-label="Open account settings"
            >
              <Settings size={20} />
            </button>
          </div>
        </header>
        
        <main className="flex-1 overflow-y-auto bg-gray-950 p-6 md:p-8">
          {children}
        </main>
      </div>

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  );
}
