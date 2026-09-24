'use client';

import { useState, useEffect } from 'react';
import { adminApi } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { useRouter } from 'next/navigation';
import { formatBytes } from '@/lib/utils';
import { 
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, 
  BarChart, Bar, PieChart, Pie, Cell, LineChart, Line, Legend, ScatterChart, Scatter, ZAxis
} from 'recharts';
import { Shield, Users, HardDrive, File as FileIcon, Loader2, AlertCircle } from 'lucide-react';

const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#8884d8', '#ff7300'];

export default function AdminStatsPage() {
  const { user } = useAuth();
  const router = useRouter();
  
  const [authStats, setAuthStats] = useState<any>(null);
  const [metaStats, setMetaStats] = useState<any>(null);
  const [users, setUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (user && user.role !== 'admin') {
      router.push('/dashboard');
    } else if (user) {
      loadData();
    }
  }, [user, router]);

  const loadData = async () => {
    try {
      const [authData, metaData, usersData] = await Promise.all([
        adminApi.getStats(),
        adminApi.getMetadataStats(),
        adminApi.getUsers()
      ]);
      setAuthStats(authData);
      setMetaStats(metaData);
      setUsers(usersData as any[]);
      setLoading(false);
    } catch (err: any) {
      setError('Failed to load admin statistics');
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-cyan-500" />
      </div>
    );
  }

  // Data processing for charts
  const topUsers = [...users].sort((a, b) => b.storage_used - a.storage_used).slice(0, 5).map(u => ({
    name: u.username,
    storage: (u.storage_used / (1024 * 1024)).toFixed(2) // MB
  }));

  const pieData = (metaStats?.files_by_type || []).map((t: any) => {
    const mainType = t.name.split('/')[0] || t.name;
    return { name: mainType, value: t.count };
  });
  
  // Aggregate pieData if there are multiple of same mainType
  const groupedPieData = pieData.reduce((acc: any[], curr: any) => {
    const existing = acc.find((item: any) => item.name === curr.name);
    if (existing) {
      existing.value += curr.value;
    } else {
      acc.push({ ...curr });
    }
    return acc;
  }, []);

  const timelineData = metaStats?.upload_timeline || [];
  
  // Scatter data (just mapping timeline to slightly different view)
  const scatterData = timelineData.map((d: any, index: number) => ({
    x: index,
    y: d.count,
    z: d.size,
    date: d.date
  }));

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-gray-900 border border-gray-700 p-3 rounded-lg shadow-xl z-50 relative">
          <p className="text-gray-200 font-medium">{`${label || ''}`}</p>
          {payload.map((p: any, i: number) => (
            <p key={i} style={{ color: p.color }} className="text-sm">
              {p.name}: {p.name === 'storage' ? p.value + ' MB' : p.name === 'size' ? formatBytes(p.value) : p.value}
            </p>
          ))}
        </div>
      );
    }
    return null;
  };

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-8 pb-20">
      <div className="flex items-center gap-4 mb-8">
        <div className="p-4 rounded-2xl bg-gradient-to-br from-cyan-500 to-blue-600 shadow-lg shadow-cyan-500/20 flex items-center justify-center">
          <Shield className="w-8 h-8 text-white" strokeWidth={2.5} />
        </div>
        <div>
          <h1 className="text-3xl font-bold text-white tracking-tight">Admin Statistics</h1>
          <p className="text-gray-400 mt-1">Deep analytics on platform usage, storage, and user behavior.</p>
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 text-red-400 p-4 rounded-xl flex items-center gap-3">
          <AlertCircle className="w-5 h-5 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 relative overflow-hidden">
          <div className="absolute top-0 right-0 w-32 h-32 bg-blue-500/5 rounded-full blur-3xl -mr-16 -mt-16"></div>
          <div className="flex items-center gap-4 mb-4 relative z-10">
            <div className="p-3 bg-blue-500/10 rounded-xl text-blue-400"><Users size={24} /></div>
            <h3 className="text-gray-400 font-medium">Total Users</h3>
          </div>
          <div className="text-3xl font-bold text-white relative z-10">{authStats?.total_users}</div>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 relative overflow-hidden">
          <div className="absolute top-0 right-0 w-32 h-32 bg-emerald-500/5 rounded-full blur-3xl -mr-16 -mt-16"></div>
          <div className="flex items-center gap-4 mb-4 relative z-10">
            <div className="p-3 bg-emerald-500/10 rounded-xl text-emerald-400"><FileIcon size={24} /></div>
            <h3 className="text-gray-400 font-medium">Total Files</h3>
          </div>
          <div className="text-3xl font-bold text-white relative z-10">{metaStats?.total_files}</div>
        </div>
        
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 relative overflow-hidden">
          <div className="absolute top-0 right-0 w-32 h-32 bg-purple-500/5 rounded-full blur-3xl -mr-16 -mt-16"></div>
          <div className="flex items-center gap-4 mb-4 relative z-10">
            <div className="p-3 bg-purple-500/10 rounded-xl text-purple-400"><HardDrive size={24} /></div>
            <h3 className="text-gray-400 font-medium">Total Storage Used</h3>
          </div>
          <div className="text-3xl font-bold text-white relative z-10">{formatBytes(authStats?.total_storage_used || 0)}</div>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 relative overflow-hidden">
          <div className="absolute top-0 right-0 w-32 h-32 bg-pink-500/5 rounded-full blur-3xl -mr-16 -mt-16"></div>
          <div className="flex items-center gap-4 mb-4 relative z-10">
            <div className="p-3 bg-pink-500/10 rounded-xl text-pink-400"><Users size={24} /></div>
            <h3 className="text-gray-400 font-medium">Active Users</h3>
          </div>
          <div className="text-3xl font-bold text-white relative z-10">{authStats?.active_users}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Area Chart - Upload Size Over Time */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 shadow-lg shadow-black/20">
          <h3 className="text-lg font-bold text-gray-200 mb-6">Storage Upload Trend</h3>
          <div className="h-[300px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={timelineData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorSize" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.8}/>
                    <stop offset="95%" stopColor="#06b6d4" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <XAxis dataKey="date" stroke="#4b5563" tick={{fill: '#9ca3af', fontSize: 12}} />
                <YAxis stroke="#4b5563" tick={{fill: '#9ca3af', fontSize: 12}} tickFormatter={(value) => formatBytes(value)} />
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" vertical={false} />
                <Tooltip content={<CustomTooltip />} />
                <Area type="monotone" dataKey="size" stroke="#06b6d4" fillOpacity={1} fill="url(#colorSize)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Line Chart - Upload Frequency */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 shadow-lg shadow-black/20">
          <h3 className="text-lg font-bold text-gray-200 mb-6">File Upload Frequency</h3>
          <div className="h-[300px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={timelineData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                <XAxis dataKey="date" stroke="#4b5563" tick={{fill: '#9ca3af', fontSize: 12}} />
                <YAxis stroke="#4b5563" tick={{fill: '#9ca3af', fontSize: 12}} />
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" vertical={false} />
                <Tooltip content={<CustomTooltip />} />
                <Legend />
                <Line type="monotone" dataKey="count" stroke="#8b5cf6" strokeWidth={3} dot={{ r: 4, fill: '#8b5cf6' }} activeDot={{ r: 8 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Bar Chart - Top Users */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 shadow-lg shadow-black/20">
          <h3 className="text-lg font-bold text-gray-200 mb-6">Top Users by Storage (MB)</h3>
          <div className="h-[300px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={topUsers} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                <XAxis dataKey="name" stroke="#4b5563" tick={{fill: '#9ca3af', fontSize: 12}} />
                <YAxis stroke="#4b5563" tick={{fill: '#9ca3af', fontSize: 12}} />
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" vertical={false} />
                <Tooltip content={<CustomTooltip />} cursor={{fill: '#374151', opacity: 0.4}} />
                <Bar dataKey="storage" fill="#3b82f6" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Pie Chart - File Types */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 shadow-lg shadow-black/20">
          <h3 className="text-lg font-bold text-gray-200 mb-6">File Type Distribution</h3>
          <div className="h-[300px] w-full flex items-center justify-center">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={groupedPieData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={100}
                  paddingAngle={5}
                  dataKey="value"
                  label={({name, percent}) => `${name} ${(percent * 100).toFixed(0)}%`}
                  labelLine={false}
                >
                  {groupedPieData.map((entry: any, index: number) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip content={<CustomTooltip />} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
        
        {/* Scatter Chart - Upload Volume vs Count */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 shadow-lg shadow-black/20 lg:col-span-2">
          <h3 className="text-lg font-bold text-gray-200 mb-6">Upload Density Analysis (Count vs Size)</h3>
          <div className="h-[300px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 20, right: 20, bottom: 20, left: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                <XAxis type="category" dataKey="date" name="Date" stroke="#4b5563" tick={{fill: '#9ca3af', fontSize: 12}} />
                <YAxis type="number" dataKey="y" name="count" stroke="#4b5563" tick={{fill: '#9ca3af', fontSize: 12}} />
                <ZAxis type="number" dataKey="z" range={[60, 400]} name="size" />
                <Tooltip cursor={{ strokeDasharray: '3 3' }} content={<CustomTooltip />} />
                <Scatter name="Uploads" data={scatterData} fill="#f59e0b" />
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
}
