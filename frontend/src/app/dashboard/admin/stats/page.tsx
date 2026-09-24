'use client';

import { useState, useEffect } from 'react';
import { adminApi } from '@/lib/api';
import { PieChart, Pie, Cell, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer, BarChart, Bar, LineChart, Line, Legend } from 'recharts';
import { Users, HardDrive, File as FileIcon, Activity, Database, PieChart as PieChartIcon } from 'lucide-react';
import { formatBytes } from '@/lib/utils';
import { motion } from 'framer-motion';

export default function AdminStatsPage() {
  const [stats, setStats] = useState<any>(null);
  const [metaStats, setMetaStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchStats();
  }, []);

  const fetchStats = async () => {
    try {
      setLoading(true);
      const [authData, metaData] = await Promise.all([
        adminApi.getStats(),
        adminApi.getMetadataStats()
      ]);
      setStats(authData);
      setMetaStats(metaData);
    } catch (err: any) {
      setError(err.message || 'Failed to load stats');
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="h-full flex flex-col items-center justify-center">
        <div className="animate-spin w-8 h-8 border-4 border-cyan-500 border-t-transparent rounded-full mb-4"></div>
        <div className="text-gray-400">Loading admin statistics...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8">
        <div className="bg-red-900/30 border border-red-500/30 text-red-400 p-4 rounded-xl">
          {error}
        </div>
      </div>
    );
  }

  // Process data for charts
  const COLORS = ['#06b6d4', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#3b82f6'];
  
  const pieData = metaStats?.files_by_type?.map((item: any) => ({
    name: item.name.split('/')[0] || item.name,
    value: item.count
  })) || [];

  // Group pie data if too many
  const groupedPie = pieData.reduce((acc: any, curr: any) => {
    const existing = acc.find((item: any) => item.name === curr.name);
    if (existing) {
      existing.value += curr.value;
    } else {
      acc.push({ ...curr });
    }
    return acc;
  }, []);

  const timelineData = metaStats?.upload_timeline?.map((item: any) => ({
    date: item.date.substring(5), // MM-DD
    files: item.count,
    sizeMB: Math.round(item.size / (1024 * 1024))
  })) || [];

  return (
    <div className="h-full flex flex-col overflow-y-auto custom-scrollbar p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white mb-2">Admin Dashboard</h1>
          <p className="text-gray-400">System statistics and usage analytics</p>
        </div>
      </div>

      {/* Top Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="bg-gray-900 border border-gray-800 rounded-2xl p-5 flex items-center justify-between">
          <div>
            <p className="text-gray-400 text-sm font-medium mb-1">Total Users</p>
            <h3 className="text-3xl font-bold text-white">{stats?.total_users || 0}</h3>
          </div>
          <div className="w-12 h-12 bg-blue-500/10 rounded-xl flex items-center justify-center text-blue-400">
            <Users size={24} />
          </div>
        </motion.div>
        
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }} className="bg-gray-900 border border-gray-800 rounded-2xl p-5 flex items-center justify-between">
          <div>
            <p className="text-gray-400 text-sm font-medium mb-1">Total Files</p>
            <h3 className="text-3xl font-bold text-white">{metaStats?.total_files || 0}</h3>
          </div>
          <div className="w-12 h-12 bg-cyan-500/10 rounded-xl flex items-center justify-center text-cyan-400">
            <FileIcon size={24} />
          </div>
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }} className="bg-gray-900 border border-gray-800 rounded-2xl p-5 flex items-center justify-between">
          <div>
            <p className="text-gray-400 text-sm font-medium mb-1">Storage Used</p>
            <h3 className="text-3xl font-bold text-white">{formatBytes(stats?.total_storage_used || 0)}</h3>
          </div>
          <div className="w-12 h-12 bg-purple-500/10 rounded-xl flex items-center justify-center text-purple-400">
            <Database size={24} />
          </div>
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }} className="bg-gray-900 border border-gray-800 rounded-2xl p-5 flex items-center justify-between">
          <div>
            <p className="text-gray-400 text-sm font-medium mb-1">Active Folders</p>
            <h3 className="text-3xl font-bold text-white">{metaStats?.total_folders || 0}</h3>
          </div>
          <div className="w-12 h-12 bg-emerald-500/10 rounded-xl flex items-center justify-center text-emerald-400">
            <HardDrive size={24} />
          </div>
        </motion.div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Storage Growth Area Chart */}
        <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.5 }} className="lg:col-span-2 bg-gray-900 border border-gray-800 rounded-2xl p-6">
          <h3 className="text-lg font-semibold text-white mb-6 flex items-center gap-2">
            <Activity size={20} className="text-cyan-400" />
            Upload Volume (Last 30 Days)
          </h3>
          <div className="h-[300px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={timelineData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorSize" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="#06b6d4" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <XAxis dataKey="date" stroke="#4b5563" fontSize={12} tickLine={false} axisLine={false} />
                <YAxis stroke="#4b5563" fontSize={12} tickLine={false} axisLine={false} />
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" vertical={false} />
                <RechartsTooltip 
                  contentStyle={{ backgroundColor: '#111827', borderColor: '#374151', borderRadius: '0.5rem', color: '#fff' }}
                  itemStyle={{ color: '#06b6d4' }}
                />
                <Area type="monotone" dataKey="sizeMB" stroke="#06b6d4" strokeWidth={3} fillOpacity={1} fill="url(#colorSize)" name="Size (MB)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </motion.div>

        {/* File Types Pie Chart */}
        <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.6 }} className="bg-gray-900 border border-gray-800 rounded-2xl p-6 flex flex-col">
          <h3 className="text-lg font-semibold text-white mb-2 flex items-center gap-2">
            <PieChartIcon size={20} className="text-purple-400" />
            File Distribution
          </h3>
          <div className="flex-1 min-h-[300px] w-full flex items-center justify-center">
            {groupedPie.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={groupedPie}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={80}
                    paddingAngle={5}
                    dataKey="value"
                    stroke="none"
                  >
                    {groupedPie.map((entry: any, index: number) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <RechartsTooltip 
                    contentStyle={{ backgroundColor: '#111827', borderColor: '#374151', borderRadius: '0.5rem', color: '#fff' }}
                  />
                  <Legend verticalAlign="bottom" height={36} iconType="circle" />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="text-gray-500">No data available</div>
            )}
          </div>
        </motion.div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* File Count Line Chart */}
        <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.7 }} className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
          <h3 className="text-lg font-semibold text-white mb-6">Files Uploaded Frequency</h3>
          <div className="h-[250px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={timelineData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" vertical={false} />
                <XAxis dataKey="date" stroke="#4b5563" fontSize={12} tickLine={false} axisLine={false} />
                <YAxis stroke="#4b5563" fontSize={12} tickLine={false} axisLine={false} />
                <RechartsTooltip 
                  contentStyle={{ backgroundColor: '#111827', borderColor: '#374151', borderRadius: '0.5rem', color: '#fff' }}
                />
                <Line type="monotone" dataKey="files" stroke="#8b5cf6" strokeWidth={3} dot={{ r: 4, fill: '#8b5cf6', strokeWidth: 0 }} activeDot={{ r: 6 }} name="Files" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </motion.div>
        
        {/* Placeholder for User stats or future charts */}
        <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.8 }} className="bg-gray-900 border border-gray-800 rounded-2xl p-6 flex flex-col items-center justify-center text-center">
          <div className="w-20 h-20 bg-gray-800 rounded-full flex items-center justify-center text-gray-500 mb-4">
            <PieChartIcon size={32} />
          </div>
          <h3 className="text-xl font-medium text-gray-200 mb-2">More Analytics Coming Soon</h3>
          <p className="text-gray-500 max-w-xs mx-auto text-sm">Future updates will include User Quota distribution, Storage prediction, and Audit Log summaries.</p>
        </motion.div>
      </div>
    </div>
  );
}
