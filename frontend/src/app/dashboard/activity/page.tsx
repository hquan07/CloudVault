'use client';

import { useState, useEffect } from 'react';
import { Activity, UploadCloud, Trash2, Edit2, Share2, FolderPlus } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { formatRelative } from '@/lib/utils';
import { metaApi } from '@/lib/api';

interface AuditLog {
  id: string;
  action: string;
  resource_type: string;
  resource_id: string;
  resource_name: string | null;
  created_at: string;
  details: any;
}

const SkeletonActivity = () => (
  <div className="relative animate-pulse">
    <div className="absolute -left-[35px] top-1 w-8 h-8 rounded-full bg-gray-800 border-2 border-gray-700"></div>
    <div className="p-4 rounded-xl border border-gray-800 bg-gray-900/50">
      <div className="flex justify-between items-start gap-4">
        <div className="w-full">
          <div className="h-4 bg-gray-800 rounded w-1/2 mb-2"></div>
          <div className="h-3 bg-gray-800 rounded w-1/3"></div>
        </div>
        <div className="h-3 bg-gray-800 rounded w-16 shrink-0"></div>
      </div>
    </div>
  </div>
);

export default function ActivityPage() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchLogs();
  }, []);

  const fetchLogs = async () => {
    try {
      setLoading(true);
      const data = await metaApi.getActivity(1, 50) as any;
      setLogs(data.activities || []);
    } catch (err: any) {
      setError(err.message || 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const getActionIcon = (action: string) => {
    if (action.includes('UPLOAD')) return <UploadCloud className="text-cyan-400" size={18} />;
    if (action.includes('DELETE')) return <Trash2 className="text-red-400" size={18} />;
    if (action.includes('UPDATE') || action.includes('RENAME')) return <Edit2 className="text-yellow-400" size={18} />;
    if (action.includes('SHARE')) return <Share2 className="text-purple-400" size={18} />;
    if (action.includes('CREATE')) return <FolderPlus className="text-green-400" size={18} />;
    return <Activity className="text-gray-400" size={18} />;
  };

  const getActionColor = (action: string) => {
    if (action.includes('UPLOAD') || action.includes('CREATE')) return 'bg-cyan-500/10 border-cyan-500/20';
    if (action.includes('DELETE')) return 'bg-red-500/10 border-red-500/20';
    if (action.includes('SHARE')) return 'bg-purple-500/10 border-purple-500/20';
    if (action.includes('UPDATE')) return 'bg-yellow-500/10 border-yellow-500/20';
    return 'bg-gray-800 border-gray-700';
  };

  const formatActionText = (log: AuditLog) => {
    const actionStr = log.action.replace(/_/g, ' ').toLowerCase();
    return (
      <span>
        <span className="font-medium text-gray-200 capitalize">{actionStr}</span>
        {' '}the {log.resource_type.toLowerCase()}{' '}
        {log.resource_name && <span className="font-semibold text-white">&quot;{log.resource_name}&quot;</span>}
      </span>
    );
  };

  if (loading) {
    return (
      <div className="h-full flex flex-col max-w-4xl mx-auto w-full">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold text-white mb-2">Activity Log</h1>
            <p className="text-gray-400">Track all changes and access to your files and folders</p>
          </div>
        </div>
        <div className="relative pl-6 border-l-2 border-gray-800 space-y-8 pb-12">
          {[...Array(5)].map((_, i) => <SkeletonActivity key={i} />)}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col max-w-4xl mx-auto w-full">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-white mb-2">Activity Log</h1>
          <p className="text-gray-400">Track all changes and access to your files and folders</p>
        </div>
      </div>

      {error && (
        <div className="mb-6 p-4 bg-red-900/30 border border-red-500/30 rounded-xl text-red-400">
          {error}
        </div>
      )}

      {logs.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center p-8 bg-gray-900/50 rounded-2xl border border-gray-800 border-dashed">
          <div className="w-20 h-20 bg-gray-800 rounded-full flex items-center justify-center text-gray-500 mb-6">
            <Activity size={40} />
          </div>
          <h3 className="text-xl font-medium text-gray-200 mb-2">No activity yet</h3>
          <p className="text-gray-500 max-w-sm mx-auto">Your recent actions will appear here.</p>
        </div>
      ) : (
        <motion.div layout className="relative pl-6 border-l-2 border-gray-800 space-y-8 pb-12">
          <AnimatePresence>
          {logs.map((log) => (
            <motion.div 
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, scale: 0.9 }}
              layout
              key={log.id} 
              className="relative"
            >
              <div className="absolute -left-[35px] top-1 w-8 h-8 rounded-full bg-gray-900 border-2 border-gray-800 flex items-center justify-center">
                {getActionIcon(log.action)}
              </div>
              <div className={`p-4 rounded-xl border ${getActionColor(log.action)} backdrop-blur-sm transition-all hover:bg-gray-800/80`}>
                <div className="flex justify-between items-start gap-4">
                  <div>
                    <p className="text-gray-300 text-sm leading-relaxed">
                      {formatActionText(log)}
                    </p>
                    {log.details && Object.keys(log.details).length > 0 && (
                      <div className="mt-3 p-3 bg-black/30 rounded-lg text-xs font-mono text-gray-400 overflow-x-auto">
                        {JSON.stringify(log.details, null, 2)}
                      </div>
                    )}
                  </div>
                  <div className="text-xs text-gray-500 whitespace-nowrap shrink-0">
                    {formatRelative(log.created_at)}
                  </div>
                </div>
              </div>
            </motion.div>
          ))}
          </AnimatePresence>
        </motion.div>
      )}
    </div>
  );
}
