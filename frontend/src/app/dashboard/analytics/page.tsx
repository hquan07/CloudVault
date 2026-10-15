'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import {
  Activity, AlertCircle, BarChart3, Clock, FileText, HardDrive,
  PieChart as PieChartIcon, RefreshCw, Share2, Star, Trash2,
} from 'lucide-react';
import { AnalyticsStats, metaApi } from '@/lib/api';
import { formatBytes } from '@/lib/utils';

export default function AnalyticsDashboard() {
  const [data, setData] = useState<AnalyticsStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const loadAnalytics = useCallback(async (background = false) => {
    if (background) setRefreshing(true);
    else setLoading(true);
    setError('');
    try {
      setData(await metaApi.getAnalytics());
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Analytics is unavailable');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadAnalytics();
    const timer = window.setInterval(() => void loadAnalytics(true), 60_000);
    return () => window.clearInterval(timer);
  }, [loadAnalytics]);

  const cards = useMemo(() => data ? [
    { icon: HardDrive, label: 'Accessible storage', value: formatBytes(data.cards.total_storage_bytes), color: 'text-emerald-300', surface: 'bg-emerald-500/10' },
    { icon: FileText, label: 'Active files', value: data.cards.active_files.toLocaleString(), color: 'text-cyan-300', surface: 'bg-cyan-500/10' },
    { icon: Star, label: 'Starred files', value: data.cards.starred_files.toLocaleString(), color: 'text-amber-300', surface: 'bg-amber-500/10' },
    { icon: Share2, label: 'Active shares', value: data.cards.active_shares.toLocaleString(), color: 'text-blue-300', surface: 'bg-blue-500/10' },
    { icon: Trash2, label: 'Trash storage', value: formatBytes(data.cards.trash_bytes), color: 'text-red-300', surface: 'bg-red-500/10' },
  ] : [], [data]);

  if (loading) {
    return <div className="flex min-h-[50vh] items-center justify-center"><RefreshCw className="animate-spin text-cyan-400" size={32} /><span className="ml-3 text-gray-400">Loading analytics…</span></div>;
  }

  if (!data) {
    return (
      <div className="mx-auto max-w-2xl rounded-2xl border border-red-500/20 bg-red-500/10 p-8 text-center">
        <AlertCircle className="mx-auto text-red-300" size={34} />
        <h1 className="mt-4 text-xl font-semibold text-white">Analytics unavailable</h1>
        <p className="mt-2 text-sm text-red-100/70">{error || 'CloudVault could not load your analytics snapshot.'}</p>
        <button onClick={() => void loadAnalytics()} className="mt-5 rounded-xl bg-cyan-500 px-4 py-2 font-medium text-gray-950">Try again</button>
      </div>
    );
  }

  const isEmpty = data.cards.active_files === 0;

  return (
    <div className="space-y-6 pb-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="rounded-xl bg-blue-500/15 p-3 text-blue-300"><BarChart3 size={26} /></span>
          <div>
            <h1 className="text-2xl font-bold text-white">Storage analytics</h1>
            <p className="mt-1 text-sm text-gray-400">Personal files and {data.scope.project_count} accessible project{data.scope.project_count === 1 ? '' : 's'}.</p>
            <p className="mt-1 text-xs text-gray-600">Updated {new Date(data.generated_at).toLocaleString()}</p>
          </div>
        </div>
        <button disabled={refreshing} onClick={() => void loadAnalytics(true)} className="inline-flex items-center justify-center gap-2 rounded-xl border border-gray-700 px-4 py-2 text-sm text-gray-300 hover:border-cyan-500/40 hover:text-cyan-300 disabled:opacity-50">
          <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {error && <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">Refresh failed; showing the last successful snapshot. {error}</div>}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {cards.map(({ icon: Icon, label, value, color, surface }) => (
          <div key={label} className="rounded-2xl border border-gray-800 bg-gray-900 p-5">
            <div className="flex items-center justify-between gap-3"><span className="text-sm text-gray-500">{label}</span><span className={`rounded-lg p-2 ${surface} ${color}`}><Icon size={18} /></span></div>
            <div className="mt-4 text-2xl font-semibold text-white">{value}</div>
          </div>
        ))}
      </div>

      {isEmpty ? (
        <div className="rounded-2xl border border-dashed border-gray-700 p-12 text-center">
          <FileText className="mx-auto text-gray-600" size={42} />
          <h2 className="mt-4 font-medium text-gray-200">No file activity yet</h2>
          <p className="mt-2 text-sm text-gray-500">Upload a personal file or add files to an accessible project to populate analytics.</p>
        </div>
      ) : (
        <>
          <div className="grid gap-5 xl:grid-cols-2">
            <section className="min-w-0 rounded-2xl border border-gray-800 bg-gray-900 p-4 sm:p-6">
              <h2 className="flex items-center gap-2 font-semibold text-white"><Activity size={18} className="text-cyan-300" /> Storage growth</h2>
              <div className="mt-5 h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={data.storage_growth} margin={{ top: 10, right: 8, left: 8, bottom: 0 }}>
                    <defs><linearGradient id="storageFill" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#22d3ee" stopOpacity={0.35} /><stop offset="95%" stopColor="#22d3ee" stopOpacity={0} /></linearGradient></defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" vertical={false} />
                    <XAxis dataKey="day" stroke="#6b7280" tickLine={false} axisLine={false} />
                    <YAxis stroke="#6b7280" tickLine={false} axisLine={false} tickFormatter={(value) => formatBytes(Number(value))} width={72} />
                    <Tooltip formatter={(value) => formatBytes(Number(value))} contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: 12 }} />
                    <Area type="monotone" dataKey="storage_bytes" name="Storage" stroke="#22d3ee" strokeWidth={3} fill="url(#storageFill)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </section>

            <section className="min-w-0 rounded-2xl border border-gray-800 bg-gray-900 p-4 sm:p-6">
              <h2 className="flex items-center gap-2 font-semibold text-white"><PieChartIcon size={18} className="text-emerald-300" /> File distribution</h2>
              <div className="mt-5 grid min-h-72 items-center gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
                <ResponsiveContainer width="100%" height={260}>
                  <PieChart><Pie data={data.file_types} dataKey="value" nameKey="name" innerRadius={60} outerRadius={95} paddingAngle={4} stroke="none">{data.file_types.map((entry) => <Cell key={entry.name} fill={entry.color} />)}</Pie><Tooltip contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: 12 }} /></PieChart>
                </ResponsiveContainer>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-1">{data.file_types.map((item) => <div key={item.name} className="flex items-center gap-2 text-sm text-gray-400"><span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: item.color }} /><span>{item.name}</span><span className="text-gray-600">{item.value}</span></div>)}</div>
              </div>
            </section>
          </div>

          <section className="min-w-0 rounded-2xl border border-gray-800 bg-gray-900 p-4 sm:p-6">
            <h2 className="flex items-center gap-2 font-semibold text-white"><Clock size={18} className="text-blue-300" /> Uploads in the last 24 hours</h2>
            <div className="mt-5 h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.upload_activity} margin={{ top: 10, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" vertical={false} />
                  <XAxis dataKey="time" stroke="#6b7280" tickLine={false} axisLine={false} />
                  <YAxis allowDecimals={false} stroke="#6b7280" tickLine={false} axisLine={false} width={40} />
                  <Tooltip contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: 12 }} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                  <Bar dataKey="uploads" name="Uploads" fill="#60a5fa" radius={[5, 5, 0, 0]} maxBarSize={56} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
