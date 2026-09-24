'use client';

import ArchitectureTab from '@/components/ArchitectureTab';

export default function ArchitecturePage() {
  return (
    <div className="space-y-6 h-full flex flex-col">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <h1 className="text-2xl font-bold">System Architecture</h1>
      </div>
      <div className="flex-1 bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden min-h-[600px]">
        <ArchitectureTab />
      </div>
    </div>
  );
}
