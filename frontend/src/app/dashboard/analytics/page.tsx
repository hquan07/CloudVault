'use client';

import { useState, useEffect } from 'react';
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer,
  LineChart, Line, PieChart, Pie, Cell, AreaChart, Area
} from 'recharts';
import { Activity, BarChart3, HardDrive, Share2, Star, Trash2, Clock, PieChart as PieChartIcon } from 'lucide-react';
import { formatBytes } from '@/lib/utils';

// Mock data initially. Later this will be populated via WebSocket from Metadata Service
const mockFileTypeData = [
  { name: 'Images', value: 450, color: '#3b82f6' },
  { name: 'Videos', value: 120, color: '#ec4899' },
  { name: 'Documents', value: 300, color: '#10b981' },
  { name: 'Archives', value: 80, color: '#f59e0b' },
  { name: 'Others', value: 50, color: '#6b7280' },
];

const mockUploadActivity = [
  { time: '00:00', uploads: 5 }, { time: '04:00', uploads: 2 },
  { time: '08:00', uploads: 45 }, { time: '12:00', uploads: 85 },
  { time: '16:00', uploads: 60 }, { time: '20:00', uploads: 25 },
];

const mockStorageGrowth = [
  { day: 'Mon', storage: 1.2 }, { day: 'Tue', storage: 1.5 },
  { day: 'Wed', storage: 2.1 }, { day: 'Thu', storage: 2.3 },
  { day: 'Fri', storage: 3.8 }, { day: 'Sat', storage: 4.2 },
  { day: 'Sun', storage: 4.5 },
];

export default function AnalyticsDashboard() {
  const [isClient, setIsClient] = useState(false);
  const [fileTypeData, setFileTypeData] = useState(mockFileTypeData);
  const [uploadActivity, setUploadActivity] = useState(mockUploadActivity);
  const [storageGrowth, setStorageGrowth] = useState(mockStorageGrowth);
  const [cardsData, setCardsData] = useState({
    totalStorage: '4.5 GB',
    starredFiles: '124',
    activeShares: '45',
    trashBin: '820 MB'
  });

  useEffect(() => {
    // Prevent SSR hydration mismatch for Recharts
    setIsClient(true);
    
    // Connect to WebSocket
    const token = typeof window !== 'undefined' ? localStorage.getItem('cloudvault_access_token') : null;
    const wsUrl = (process.env.NEXT_PUBLIC_WS_URL || `ws://${window.location.host}/api/v1/analytics/ws`) + (token ? `?token=${token}` : '');
    const ws = new WebSocket(wsUrl);
    
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.fileTypeData) setFileTypeData(data.fileTypeData);
        if (data.uploadActivity) setUploadActivity(data.uploadActivity);
        if (data.storageGrowth) setStorageGrowth(data.storageGrowth);
        if (data.cards) setCardsData(data.cards);
      } catch (e) {
        console.error("Error parsing analytics WebSocket data", e);
      }
    };

    // Fetch initial stats
    fetch('/api/v1/analytics/stats', {
      headers: token ? { 'Authorization': `Bearer ${token}` } : {}
    })
      .then(async (res) => {
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`Analytics API error: ${res.status} ${text.slice(0, 50)}`);
        }
        return res.json();
      })
      .then(data => {
        if (data.fileTypeData) setFileTypeData(data.fileTypeData);
        if (data.uploadActivity) setUploadActivity(data.uploadActivity);
        if (data.storageGrowth) setStorageGrowth(data.storageGrowth);
        if (data.cards) setCardsData(data.cards);
      })
      .catch(err => console.error("Error fetching initial stats", err));

    return () => {
      ws.close();
    };
  }, []);

  if (!isClient) return null;

  return (
    <div style={{ paddingBottom: '2rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 32 }}>
        <div style={{ padding: 12, background: 'rgba(59, 130, 246, 0.2)', borderRadius: 12, color: 'var(--color-primary)' }}>
          <BarChart3 size={28} />
        </div>
        <div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 700, margin: 0 }}>Product Analytics</h1>
          <p style={{ color: 'var(--text-muted)', margin: 0, marginTop: 4 }}>Real-time overview of your cloud storage usage</p>
        </div>
      </div>

      {/* Stats Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '20px', marginBottom: '32px' }}>
        {[
          { icon: HardDrive, label: 'Total Storage', value: cardsData.totalStorage, color: '#10b981', trend: '+12% this week' },
          { icon: Star, label: 'Starred Files', value: cardsData.starredFiles, color: '#f59e0b', trend: '8 newly starred' },
          { icon: Share2, label: 'Active Shares', value: cardsData.activeShares, color: '#3b82f6', trend: '3 expiring soon' },
          { icon: Trash2, label: 'Trash Bin', value: cardsData.trashBin, color: '#ef4444', trend: 'Auto-empty in 5d' },
        ].map((stat, i) => (
          <div key={i} style={{ 
            background: 'var(--bg-surface)', 
            padding: '24px', 
            borderRadius: '16px', 
            border: '1px solid var(--border-color)',
            position: 'relative',
            overflow: 'hidden'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <div style={{ color: 'var(--text-muted)', fontWeight: 500 }}>{stat.label}</div>
              <div style={{ background: `${stat.color}20`, color: stat.color, padding: 8, borderRadius: 8 }}>
                <stat.icon size={20} />
              </div>
            </div>
            <div style={{ fontSize: '2rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: 8 }}>{stat.value}</div>
            <div style={{ fontSize: '0.875rem', color: stat.color }}>{stat.trend}</div>
            
            {/* Glassmorphism Glow Effect */}
            <div style={{
              position: 'absolute', top: -50, right: -50, width: 100, height: 100,
              background: stat.color, opacity: 0.1, filter: 'blur(40px)', borderRadius: '50%'
            }} />
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: '20px', marginBottom: '20px' }}>
        
        {/* Storage Growth - Area Chart */}
        <div style={{ background: 'var(--bg-surface)', padding: '24px', borderRadius: '16px', border: '1px solid var(--border-color)' }}>
          <h3 style={{ fontSize: '1.125rem', fontWeight: 600, marginBottom: 24, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Activity size={18} color="var(--color-primary)" /> Storage Growth (GB)
          </h3>
          <div style={{ height: 300 }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={storageGrowth} margin={{ top: 20, right: 20, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorStorage" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--color-primary)" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="var(--color-primary)" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" vertical={false} />
                <XAxis dataKey="day" stroke="var(--text-muted)" tick={{fill: 'var(--text-muted)'}} axisLine={false} tickLine={false} tickMargin={10} />
                <YAxis stroke="var(--text-muted)" tick={{fill: 'var(--text-muted)'}} axisLine={false} tickLine={false} tickMargin={10} width={40} />
                <RechartsTooltip 
                  contentStyle={{ background: '#1f2937', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, color: '#fff' }}
                  itemStyle={{ color: '#fff' }}
                />
                <Area type="monotone" dataKey="storage" stroke="var(--color-primary)" strokeWidth={3} fillOpacity={1} fill="url(#colorStorage)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* File Type Distribution - Donut Chart */}
        <div style={{ background: 'var(--bg-surface)', padding: '24px', borderRadius: '16px', border: '1px solid var(--border-color)' }}>
          <h3 style={{ fontSize: '1.125rem', fontWeight: 600, marginBottom: 24, display: 'flex', alignItems: 'center', gap: 8 }}>
            <PieChartIcon size={18} color="var(--color-accent)" /> File Distribution
          </h3>
          <div style={{ height: 300, display: 'flex', alignItems: 'center' }}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={fileTypeData}
                  cx="50%" cy="50%" innerRadius={80} outerRadius={110}
                  paddingAngle={5} dataKey="value" stroke="none"
                >
                  {fileTypeData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                <RechartsTooltip 
                  contentStyle={{ background: '#1f2937', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, color: '#fff' }}
                  itemStyle={{ color: '#fff' }}
                />
              </PieChart>
            </ResponsiveContainer>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 120 }}>
              {fileTypeData.map(item => (
                <div key={item.name} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ width: 12, height: 12, borderRadius: 4, background: item.color }} />
                  <span style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>{item.name}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

      </div>

      {/* Upload Activity - Bar Chart */}
      <div style={{ background: 'var(--bg-surface)', padding: '24px', borderRadius: '16px', border: '1px solid var(--border-color)', width: '100%' }}>
        <h3 style={{ fontSize: '1.125rem', fontWeight: 600, marginBottom: 24, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Clock size={18} color="var(--color-secondary)" /> Upload Activity Today
        </h3>
        <div style={{ height: 300 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={uploadActivity} margin={{ top: 20, right: 20, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" vertical={false} />
              <XAxis dataKey="time" stroke="var(--text-muted)" tick={{fill: 'var(--text-muted)'}} axisLine={false} tickLine={false} tickMargin={10} />
              <YAxis stroke="var(--text-muted)" tick={{fill: 'var(--text-muted)'}} axisLine={false} tickLine={false} tickMargin={10} width={40} />
              <RechartsTooltip 
                contentStyle={{ background: '#1f2937', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, color: '#fff' }}
                itemStyle={{ color: '#fff' }}
                cursor={{ fill: 'rgba(255,255,255,0.05)' }}
              />
              <Bar dataKey="uploads" fill="var(--color-secondary)" radius={[4, 4, 0, 0]} maxBarSize={50} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
