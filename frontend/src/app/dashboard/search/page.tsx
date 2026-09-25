'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { File as FileIcon, Download, Search as SearchIcon, Share2, Star, SlidersHorizontal, X, ChevronLeft, ChevronRight } from 'lucide-react';
import { metaApi, fileApi } from '@/lib/api';
import { formatBytes, formatRelative } from '@/lib/utils';
import { FilePreviewModal } from '@/components/FilePreviewModal';
import { ShareModal } from '@/components/ShareModal';
import type { FileItem } from '@/app/dashboard/page';

type SearchFile = FileItem & { highlight?: { original_name?: string[]; content?: string[] } };

function Highlight({ value }: { value: string }) {
  const parts = value.split(/(<em>.*?<\/em>)/gi);
  return <>{parts.map((part, index) => part.toLowerCase().startsWith('<em>')
    ? <mark key={index} className="rounded bg-cyan-500/20 px-0.5 text-cyan-300">{part.replace(/<\/?em>/gi, '')}</mark>
    : <span key={index}>{part.replace(/<[^>]*>/g, '')}</span>)}</>;
}

function SearchResults() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const initialQuery = searchParams.get('q') || '';
  const [query, setQuery] = useState(initialQuery);
  const [debouncedQuery, setDebouncedQuery] = useState(initialQuery);
  const [files, setFiles] = useState<SearchFile[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [mimeType, setMimeType] = useState('');
  const [minMb, setMinMb] = useState('');
  const [maxMb, setMaxMb] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [sortBy, setSortBy] = useState<'relevance' | 'created_at' | 'updated_at' | 'size'>('relevance');
  const [previewFile, setPreviewFile] = useState<SearchFile | null>(null);
  const [shareFile, setShareFile] = useState<SearchFile | null>(null);
  const [recent, setRecent] = useState<string[]>([]);

  useEffect(() => setRecent(JSON.parse(localStorage.getItem('cloudvault_recent_searches') || '[]')), []);
  useEffect(() => {
    const timer = window.setTimeout(() => { setDebouncedQuery(query.trim()); setPage(1); }, 350);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!debouncedQuery) { setFiles([]); setTotal(0); return; }
    const load = async () => {
      setLoading(true); setError('');
      try {
        const data = await metaApi.search({ q: debouncedQuery, page, pageSize: 20, mimeType,
          minSize: minMb ? Number(minMb) * 1024 * 1024 : undefined,
          maxSize: maxMb ? Number(maxMb) * 1024 * 1024 : undefined,
          dateFrom: dateFrom ? `${dateFrom}T00:00:00Z` : undefined,
          dateTo: dateTo ? `${dateTo}T23:59:59Z` : undefined, sortBy,
        }) as { files: SearchFile[]; total: number };
        setFiles(data.files || []); setTotal(data.total || 0);
        setRecent(current => {
          const next = [debouncedQuery, ...current.filter(item => item !== debouncedQuery)].slice(0, 6);
          localStorage.setItem('cloudvault_recent_searches', JSON.stringify(next)); return next;
        });
        router.replace(`/dashboard/search?q=${encodeURIComponent(debouncedQuery)}`, { scroll: false });
      } catch (err: any) { setError(err.message || 'Search failed'); }
      finally { setLoading(false); }
    };
    void load();
  }, [debouncedQuery, page, mimeType, minMb, maxMb, dateFrom, dateTo, sortBy, router]);

  const toggleStar = async (file: SearchFile) => {
    await metaApi.updateFile(file.id, { is_starred: !file.is_starred });
    setFiles(current => current.map(item => item.id === file.id ? { ...item, is_starred: !item.is_starred } : item));
  };
  const clearFilters = () => { setMimeType(''); setMinMb(''); setMaxMb(''); setDateFrom(''); setDateTo(''); setSortBy('relevance'); setPage(1); };
  const totalPages = Math.max(1, Math.ceil(total / 20));

  return <div className="space-y-6">
    <div><h1 className="text-2xl font-bold">Advanced Search</h1><p className="mt-1 text-sm text-gray-500">Search names and indexed document content.</p></div>
    <div className="rounded-2xl border border-gray-800 bg-gray-900 p-4">
      <div className="flex gap-2"><div className="relative flex-1"><SearchIcon className="absolute left-3 top-3 text-gray-500" size={18} /><input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="Search files and content…" className="w-full rounded-xl border border-gray-700 bg-gray-950 py-2.5 pl-10 pr-4 text-gray-100 outline-none focus:border-cyan-500" /></div><button onClick={() => setShowFilters(v => !v)} className={`flex items-center gap-2 rounded-xl border px-4 ${showFilters ? 'border-cyan-500 bg-cyan-500/10 text-cyan-400' : 'border-gray-700 text-gray-300'}`}><SlidersHorizontal size={18} /> Filters</button></div>
      {recent.length > 0 && !query && <div className="mt-3 flex flex-wrap gap-2">{recent.map(item => <button key={item} onClick={() => setQuery(item)} className="rounded-full bg-gray-800 px-3 py-1 text-xs text-gray-400 hover:text-white">{item}</button>)}</div>}
      {showFilters && <div className="mt-4 grid grid-cols-2 gap-3 border-t border-gray-800 pt-4 md:grid-cols-4 lg:grid-cols-7">
        <select value={mimeType} onChange={e => { setMimeType(e.target.value); setPage(1); }} className="rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm"><option value="">All types</option><option value="image/">Images</option><option value="video/">Videos</option><option value="audio/">Audio</option><option value="application/pdf">PDF</option><option value="text/">Text</option></select>
        <input value={minMb} onChange={e => setMinMb(e.target.value)} type="number" min="0" placeholder="Min MB" className="rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm" /><input value={maxMb} onChange={e => setMaxMb(e.target.value)} type="number" min="0" placeholder="Max MB" className="rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm" />
        <input value={dateFrom} onChange={e => setDateFrom(e.target.value)} type="date" className="rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm" /><input value={dateTo} onChange={e => setDateTo(e.target.value)} type="date" className="rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm" />
        <select value={sortBy} onChange={e => { setSortBy(e.target.value as typeof sortBy); setPage(1); }} className="rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm"><option value="relevance">Relevance</option><option value="updated_at">Recently updated</option><option value="created_at">Recently created</option><option value="size">Largest</option></select><button onClick={clearFilters} className="flex items-center justify-center gap-1 rounded-lg text-sm text-gray-400 hover:text-white"><X size={15} /> Reset</button>
      </div>}
    </div>
    {error && <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">{error}</div>}
    {loading ? <div className="p-16 text-center text-gray-500">Searching…</div> : files.length === 0 ? <div className="rounded-2xl border-2 border-dashed border-gray-800 py-20 text-center text-gray-500"><SearchIcon size={34} className="mx-auto mb-3" /><p>{debouncedQuery ? 'No matching files' : 'Enter a search term'}</p></div> : <>
      <div className="flex items-center justify-between text-sm text-gray-500"><span>{total} result{total === 1 ? '' : 's'}</span><span>Page {page} of {totalPages}</span></div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{files.map(file => <div key={file.id} onClick={() => setPreviewFile(file)} className="group cursor-pointer rounded-2xl border border-gray-800 bg-gray-900 p-5 hover:border-cyan-500/40"><div className="mb-4 flex justify-between"><div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gray-800 text-cyan-400"><FileIcon size={22} /></div><div className="flex opacity-0 group-hover:opacity-100"><button onClick={e => { e.stopPropagation(); void toggleStar(file); }} className={`p-2 ${file.is_starred ? 'text-yellow-400' : 'text-gray-500'}`}><Star size={17} /></button><button onClick={e => { e.stopPropagation(); setShareFile(file); }} className="p-2 text-gray-500 hover:text-cyan-400"><Share2 size={17} /></button><button onClick={async e => { e.stopPropagation(); const data = await fileApi.download(file.id); window.location.href = data.download_url; }} className="p-2 text-gray-500 hover:text-cyan-400"><Download size={17} /></button></div></div><h3 className="truncate font-medium text-gray-200"><Highlight value={file.highlight?.original_name?.[0] || file.original_name} /></h3>{file.highlight?.content?.[0] && <p className="mt-2 line-clamp-2 text-xs text-gray-400"><Highlight value={file.highlight.content[0]} /></p>}<div className="mt-4 flex justify-between text-xs text-gray-500"><span>{formatBytes(file.size || 0)}</span><span>{file.created_at ? formatRelative(file.created_at) : ''}</span></div></div>)}</div>
      <div className="flex justify-center gap-3"><button disabled={page === 1} onClick={() => setPage(v => v - 1)} className="rounded-lg border border-gray-700 p-2 disabled:opacity-30"><ChevronLeft size={18} /></button><button disabled={page >= totalPages} onClick={() => setPage(v => v + 1)} className="rounded-lg border border-gray-700 p-2 disabled:opacity-30"><ChevronRight size={18} /></button></div>
    </>}
    {previewFile && <FilePreviewModal file={previewFile} siblings={files} onSelect={file => setPreviewFile(file as SearchFile)} onClose={() => setPreviewFile(null)} />}{shareFile && <ShareModal file={shareFile} onClose={() => setShareFile(null)} />}
  </div>;
}

export default function SearchPage() { return <Suspense fallback={<div className="p-12 text-center text-gray-500">Loading…</div>}><SearchResults /></Suspense>; }
