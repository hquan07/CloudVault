'use client';

import { useState, useEffect } from 'react';
import { FolderOpen, Users } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { fileApi } from '@/lib/api';
import { formatBytes } from '@/lib/utils';
import { FilePreviewModal } from '@/components/FilePreviewModal';

export interface FolderItem {
  id: string;
  name: string;
  parent_id: string | null;
  path: string;
  depth: number;
  created_at: string;
}

const SkeletonCard = () => (
  <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 animate-pulse flex items-center gap-4">
    <div className="w-12 h-12 rounded-xl bg-gray-800 shrink-0"></div>
    <div className="h-4 bg-gray-800 rounded flex-1"></div>
  </div>
);

export default function SharedWithMePage() {
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchSharedFolders();
  }, []);

  const fetchSharedFolders = async () => {
    try {
      setLoading(true);
      const data = await fileApi.getSharedFolders() as any;
      setFolders(data.folders || []);
    } catch (err: any) {
      setError(err.message || 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="h-full flex flex-col">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold text-white mb-2">Shared with me</h1>
            <p className="text-gray-400">Folders that others have shared with you</p>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => <SkeletonCard key={i} />)}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-white mb-2">Shared with me</h1>
          <p className="text-gray-400">Folders that others have shared with you</p>
        </div>
      </div>

      {error && (
        <div className="mb-6 p-4 bg-red-900/30 border border-red-500/30 rounded-xl text-red-400">
          {error}
        </div>
      )}

      {folders.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center p-8 bg-gray-900/50 rounded-2xl border border-gray-800 border-dashed">
          <div className="w-20 h-20 bg-gray-800 rounded-full flex items-center justify-center text-gray-500 mb-6">
            <Users size={40} />
          </div>
          <h3 className="text-xl font-medium text-gray-200 mb-2">No shared folders</h3>
          <p className="text-gray-500 max-w-sm mx-auto">When someone shares a folder with you, it will appear here.</p>
        </div>
      ) : (
        <motion.div layout className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          <AnimatePresence>
          {folders.map(folder => (
            <motion.div 
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              layout
              key={folder.id} 
              className="group bg-gray-900 border border-gray-700 rounded-2xl p-5 hover:border-cyan-500/50 transition-all hover:shadow-lg hover:shadow-cyan-900/10 flex items-center gap-4 cursor-pointer"
            >
              <div className="w-12 h-12 rounded-xl bg-cyan-900/30 flex items-center justify-center text-cyan-400 shrink-0 relative overflow-hidden">
                <FolderOpen size={24} className="fill-current opacity-80 z-10" />
                <Users size={12} className="absolute bottom-2 right-2 z-20 text-white" />
              </div>
              <h4 className="font-medium text-gray-200 truncate flex-1" title={folder.name}>
                {folder.name}
              </h4>
            </motion.div>
          ))}
          </AnimatePresence>
        </motion.div>
      )}
    </div>
  );
}
