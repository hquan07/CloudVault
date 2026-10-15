'use client';
import { useEffect, useState, ReactNode } from 'react';
import { useAuth } from '@/lib/auth-context';
import { getToken } from '@/lib/api';
import { Bell, X } from 'lucide-react';
import {
    AccountPreferences,
    applyPreferences,
    loadPreferences,
    PREFERENCES_EVENT,
} from '@/lib/preferences';

interface NotificationData {
    id: string;
    type: string;
    message?: string;
    action?: string;
    resource_name?: string;
}

export function NotificationProvider({ children }: { children: ReactNode }) {
    const { user } = useAuth();
    const [notifications, setNotifications] = useState<NotificationData[]>([]);
    const [preferences, setPreferences] = useState<AccountPreferences>(() => loadPreferences());

    useEffect(() => {
        applyPreferences(preferences);
        const handlePreferences = (event: Event) => {
            const updated = (event as CustomEvent<AccountPreferences>).detail;
            setPreferences(updated);
            applyPreferences(updated);
        };
        window.addEventListener(PREFERENCES_EVENT, handlePreferences);
        return () => window.removeEventListener(PREFERENCES_EVENT, handlePreferences);
    }, [preferences]);

    useEffect(() => {
        if (!user || (!preferences.inAppNotifications && !preferences.browserNotifications)) return;
        const token = getToken();
        if (!token) return;

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/api/v1/metadata/ws/notifications`;
        
        const ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            ws.send(JSON.stringify({ type: 'authenticate', token }));
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                const id = Math.random().toString(36).substring(7);
                if (preferences.inAppNotifications) {
                    setNotifications(prev => [...prev, { id, ...data }]);
                }
                
                // Show browser notification if permitted
                if (preferences.browserNotifications && 'Notification' in window && Notification.permission === 'granted') {
                    new Notification('CloudVault', { body: data.message });
                }

                if (preferences.inAppNotifications) {
                    setTimeout(() => {
                        setNotifications(prev => prev.filter(n => n.id !== id));
                    }, 8000);
                }
            } catch (e) {
                console.error("WebSocket message error", e);
            }
        };

        return () => ws.close();
    }, [preferences.browserNotifications, preferences.inAppNotifications, user]);

    return (
        <>
            {children}
            <div className="fixed bottom-6 right-6 z-[100] flex flex-col gap-3 pointer-events-none">
                {notifications.map(n => (
                    <div key={n.id} className="bg-indigo-600/90 text-white px-4 py-3 rounded-xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] flex items-center gap-3 backdrop-blur-md pointer-events-auto transform transition-all duration-300">
                        <div className="bg-indigo-500/50 p-2 rounded-full">
                            <Bell className="w-5 h-5 text-white" />
                        </div>
                        <span className="text-sm font-medium mr-4">
                            {n.message || `${n.action || 'Activity'}${n.resource_name ? `: ${n.resource_name}` : ''}`}
                        </span>
                        <button 
                            onClick={() => setNotifications(prev => prev.filter(x => x.id !== n.id))} 
                            className="text-indigo-200 hover:text-white p-1 rounded-md hover:bg-white/10 transition-colors"
                        >
                            <X className="w-4 h-4" />
                        </button>
                    </div>
                ))}
            </div>
        </>
    );
}
