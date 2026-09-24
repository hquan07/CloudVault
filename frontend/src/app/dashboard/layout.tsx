'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import { Cloud, Folder, Clock, Star, Trash2, Settings, LogOut, Search, Menu, Shield, Network, PieChart, Users, Activity, Bell } from 'lucide-react';
import { formatBytes } from '@/lib/utils';
import { SettingsModal } from '@/components/SettingsModal';
import { AnimatePresence, motion } from 'framer-motion';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { user, loading, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [showSettings, setShowSettings] = useState(false);
  const [toast, setToast] = useState<{message: string, id: number} | null>(null);

  useEffect(() => {
    if (user) {
      const token = localStorage.getItem('token');
      if (token) {
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${wsProtocol}//${window.location.host}/api/v1/metadata/ws/notifications?token=${token}`);
        
        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            const actionText = data.action === 'UPLOAD_FILE' ? 'uploaded' : data.action === 'CREATE_FOLDER' ? 'created' : data.action;
            setToast({
              id: Date.now(),
              message: `You just ${actionText.toLowerCase()}: ${data.resource_name}`,
            });
            setTimeout(() => setToast(null), 4000);
          } catch (e) {}
        };
        return () => ws.close();
      }
    }
  }, [user]);

  useEffect(() => {
    if (!loading && !user) {
      router.push('/');
    }
  }, [user, loading, router]);

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
    { name: 'Shared with me', path: '/dashboard/shared-with-me', icon: Users },
    { name: 'Recent', path: '/dashboard/recent', icon: Clock },
    { name: 'Starred', path: '/dashboard/starred', icon: Star },
    { name: 'Activity Log', path: '/dashboard/activity', icon: Activity },
    { name: 'Trash', path: '/dashboard/trash', icon: Trash2 },
  ];

  if (user?.role === 'admin') {
    navItems.push({ name: 'Architecture', path: '/dashboard/architecture', icon: Network });
    navItems.push({ name: 'Admin Panel', path: '/dashboard/admin', icon: Shield });
    navItems.push({ name: 'Admin Stats', path: '/dashboard/admin/stats', icon: PieChart });
  }

  const usagePercent = Math.min(100, (user.storage_used / user.storage_quota) * 100);

  return (
    <div className="flex h-screen bg-gray-950 text-gray-100 overflow-hidden font-sans">
      {/* Sidebar */}
      <aside className="w-64 bg-gray-900 border-r border-gray-800 flex flex-col hidden md:flex z-20 shadow-xl">
        <div className="h-16 flex items-center px-6 border-b border-gray-800">
          <div className="flex items-center space-x-2 text-cyan-400">
            <Cloud size={28} />
            <span className="text-xl font-bold tracking-tight text-white">CloudVault</span>
          </div>
        </div>
        
        <nav className="flex-1 overflow-y-auto py-6 px-4 space-y-1.5">
          {navItems.map((item) => {
            const isActive = pathname === item.path;
            const Icon = item.icon;
            return (
              <Link
                key={item.name}
                href={item.path}
                className={`flex items-center space-x-3 px-4 py-3 rounded-xl transition-all duration-200 ${
                  isActive 
                    ? 'bg-cyan-500/10 text-cyan-400 font-medium' 
                    : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
                }`}
              >
                <Icon size={20} className={isActive ? 'text-cyan-400' : 'text-gray-500'} />
                <span>{item.name}</span>
              </Link>
            );
          })}
        </nav>

        <div className="p-6 border-t border-gray-800">
          <div className="mb-4">
            <div className="flex justify-between text-xs mb-1.5 text-gray-400">
              <span>Storage</span>
              <span>{Math.round(usagePercent)}%</span>
            </div>
            <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
              <div 
                className={`h-full rounded-full transition-all duration-500 ${usagePercent > 90 ? 'bg-red-500' : 'bg-cyan-500'}`} 
                style={{ width: `${usagePercent}%` }}
              ></div>
            </div>
            <div className="text-[11px] text-gray-500 mt-2 font-medium">
              {formatBytes(user.storage_used)} of {formatBytes(user.storage_quota)} used
            </div>
          </div>
          
          <div className="flex items-center justify-between p-3 bg-gray-800/50 rounded-xl">
            <div className="flex items-center space-x-3 overflow-hidden">
              <div className="w-9 h-9 bg-gradient-to-tr from-cyan-500 to-blue-500 rounded-full flex items-center justify-center text-sm font-bold text-white uppercase flex-shrink-0">
                {user.username.charAt(0)}
              </div>
              <div className="truncate">
                <div className="text-sm font-medium truncate">{user.username}</div>
                <div className="text-xs text-gray-400 truncate">{user.email}</div>
              </div>
            </div>
            <button onClick={logout} className="p-2 text-gray-400 hover:text-red-400 hover:bg-red-400/10 rounded-lg transition-colors" title="Log out">
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-16 bg-gray-900/50 backdrop-blur-md border-b border-gray-800 flex items-center px-6 z-10 relative">
          <div className="flex items-center w-1/3">
            <button className="md:hidden p-2 text-gray-400 hover:bg-gray-800 rounded-lg">
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
      
      {/* Toast Notification */}
      <AnimatePresence>
        {toast && (
          <motion.div
            key={toast.id}
            initial={{ opacity: 0, y: 50, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.9 }}
            className="fixed bottom-6 right-6 z-50 bg-gray-900 border border-gray-700 shadow-2xl rounded-xl p-4 flex items-center space-x-3 max-w-sm"
          >
            <div className="w-10 h-10 bg-cyan-500/20 rounded-full flex items-center justify-center text-cyan-400 flex-shrink-0">
              <Bell size={20} />
            </div>
            <div>
              <h4 className="text-sm font-semibold text-white">Activity Alert</h4>
              <p className="text-xs text-gray-400 mt-0.5 truncate">{toast.message}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
