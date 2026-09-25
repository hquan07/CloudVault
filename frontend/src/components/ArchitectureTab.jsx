import React, { useState, useCallback } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MarkerType,
  applyNodeChanges,
  applyEdgeChanges,
  Handle,
  Position,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Monitor,
  Server,
  TerminalSquare,
  Database,
  Activity,
  Zap,
  Globe,
  Shield,
  Folder,
  FileText,
  Share2,
  Bell,
  Lock,
  Archive,
  Image,
  Search,
  User
} from 'lucide-react';

// --- Architecture metadata shown when a node is selected ---
const getMetricsForNode = (nodeId) => {
  const metricsMap = {
    user: { desc: 'Platform Users', stat: 'Online: 1,204' },
    web: { desc: 'Next.js App', stat: 'Active Sessions: 1,150' },
    file_preview: { desc: 'Preview Component', stat: 'Renders/s: 24' },
    share_ui: { desc: 'Share Component', stat: 'Interactions/m: 45' },
    auth_context: { desc: 'React Context', stat: 'State Updates: 12/s' },
    notifications: { desc: 'WS Connection', stat: 'Latency: 12ms' },
    api_client: { desc: 'API Gateway/Client', stat: 'Requests: 350/s' },
    nginx: { desc: 'Nginx Gateway', stat: 'Exposure: Public host entry point' },
    
    auth: { desc: 'FastAPI Auth', stat: 'Tokens/s: 45' },
    files: { desc: 'Streaming File API', stat: 'Chunk Buffer: 1MB' },
    metadata: { desc: 'Metadata + WebSocket', stat: 'Queries: 210/s' },
    
    kafka: { desc: 'Apache Kafka', stat: 'Network: Docker-internal only' },
    redis: { desc: 'Redis Cache/PubSub', stat: 'Authenticated · Docker-internal only' },
    
    audit_worker: { desc: 'Audit Logger', stat: 'Processed: 120/s' },
    zip_worker: { desc: 'ZIP Extractor', stat: 'Active Jobs: 14' },
    thumbnail_worker: { desc: 'Thumbnail Worker', stat: 'Queue Size: 2' },
    search_worker: { desc: 'Search Indexer', stat: 'Docs/s: 45' },
    notification_relay: { desc: 'Kafka → Redis Relay', stat: 'Consumer Group: metadata-notifications' },
    
    mysql: { desc: 'MySQL DB', stat: 'Network: Docker-internal only' },
    minio: { desc: 'MinIO Storage', stat: 'Host access: Loopback only' },
    elasticsearch: { desc: 'Elasticsearch', stat: 'Auth: cloudvault_app · Internal only' },
  };
  return metricsMap[nodeId] || { desc: 'System Component', stat: 'Healthy' };
};

// --- Custom Node Component ---
const CustomNode = ({ id, data }) => {
  const [isHealthy, setIsHealthy] = useState(true);
  const [showMetrics, setShowMetrics] = useState(false);

  // Icons mapping
  const IconMap = {
    monitor: Monitor,
    globe: Globe,
    server: Server,
    terminal: TerminalSquare,
    database: Database,
    activity: Activity,
    zap: Zap,
    shield: Shield,
    folder: Folder,
    filetext: FileText,
    share: Share2,
    bell: Bell,
    lock: Lock,
    archive: Archive,
    image: Image,
    search: Search,
    user: User
  };
  
  const Icon = IconMap[data.icon] || Server;

  const handleDoubleClick = () => setIsHealthy(!isHealthy);
  const handleClick = () => setShowMetrics(!showMetrics);

  const metrics = getMetricsForNode(id);

  return (
    <div
      onDoubleClick={handleDoubleClick}
      onClick={handleClick}
      style={{
        padding: '12px 16px',
        borderRadius: '12px',
        background: isHealthy ? 'rgba(30, 41, 59, 0.9)' : 'rgba(127, 29, 29, 0.9)',
        border: `2px solid ${isHealthy ? data.color || '#475569' : '#ef4444'}`,
        color: '#fff',
        width: '200px',
        boxShadow: isHealthy ? '0 4px 6px -1px rgba(0, 0, 0, 0.3)' : '0 0 15px rgba(239, 68, 68, 0.7)',
        position: 'relative',
        transition: 'all 0.3s ease',
        cursor: 'pointer'
      }}
    >
      <Handle type="target" position={Position.Top} style={{ background: '#94a3b8' }} />
      
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
        <div style={{ padding: '8px', background: 'rgba(255,255,255,0.1)', borderRadius: '8px', display: 'flex' }}>
          <Icon size={20} color={isHealthy ? (data.color || '#fff') : '#fff'} />
        </div>
        <div>
          <div style={{ fontWeight: 600, fontSize: '14px' }}>{data.label}</div>
          <div style={{ fontSize: '11px', color: '#cbd5e1' }}>{data.sublabel}</div>
        </div>
      </div>

      {/* Health Status Indicator */}
      <div style={{
        position: 'absolute', top: '-6px', right: '-6px',
        width: '14px', height: '14px', borderRadius: '50%',
        background: isHealthy ? '#22c55e' : '#ef4444',
        border: '2px solid #0f172a',
        boxShadow: isHealthy ? '0 0 8px #22c55e' : '0 0 8px #ef4444',
        animation: isHealthy ? 'none' : 'pulse 1s infinite'
      }} />

      {/* Metrics Tooltip */}
      {showMetrics && (
        <div style={{
          position: 'absolute', top: '105%', left: 0, width: '100%',
          background: 'rgba(15, 23, 42, 0.95)', border: '1px solid #334155',
          borderRadius: '8px', padding: '10px', fontSize: '12px', zIndex: 50,
          boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.5)'
        }}>
          <div style={{ color: '#94a3b8', marginBottom: '4px' }}>{metrics.desc}</div>
          <div style={{ fontWeight: 'bold', color: '#38bdf8' }}>{metrics.stat}</div>
        </div>
      )}

      <Handle type="source" position={Position.Bottom} style={{ background: '#94a3b8' }} />
    </div>
  );
};

const nodeTypes = {
  custom: CustomNode,
};

// --- Initial Nodes Data ---
const initialNodes = [
  // Layer 1
  { id: 'user', type: 'custom', position: { x: 600, y: 0 }, data: { label: 'End User', sublabel: 'Client', icon: 'user', color: '#3b82f6' } },
  
  // Layer 1.5
  { id: 'nginx', type: 'custom', position: { x: 600, y: 120 }, data: { label: 'Nginx LB', sublabel: 'Public Host Entry', icon: 'globe', color: '#10b981' } },

  // Layer 2
  { id: 'web', type: 'custom', position: { x: 600, y: 240 }, data: { label: 'Next.js App', sublabel: 'Web Application', icon: 'monitor', color: '#3b82f6' } },
  
  // Layer 3
  { id: 'file_preview', type: 'custom', position: { x: 100, y: 240 }, data: { label: 'File Preview', sublabel: 'UI Component', icon: 'filetext', color: '#3b82f6' } },
  { id: 'share_ui', type: 'custom', position: { x: 350, y: 240 }, data: { label: 'Share UI', sublabel: 'UI Component', icon: 'share', color: '#3b82f6' } },
  { id: 'auth_context', type: 'custom', position: { x: 850, y: 240 }, data: { label: 'Auth State', sublabel: 'React Context', icon: 'lock', color: '#3b82f6' } },
  { id: 'notifications', type: 'custom', position: { x: 1100, y: 240 }, data: { label: 'Notifications', sublabel: 'UI Component', icon: 'bell', color: '#3b82f6' } },
  
  // Layer 4
  { id: 'api_client', type: 'custom', position: { x: 600, y: 360 }, data: { label: 'API Client', sublabel: 'Fetch + Token Refresh', icon: 'activity', color: '#3b82f6' } },
  
  // Layer 5 Services
  { id: 'auth', type: 'custom', position: { x: 350, y: 520 }, data: { label: 'Auth Service', sublabel: 'FastAPI', icon: 'shield', color: '#f59e0b' } },
  { id: 'files', type: 'custom', position: { x: 600, y: 520 }, data: { label: 'File Service', sublabel: 'Streaming FastAPI', icon: 'folder', color: '#f59e0b' } },
  { id: 'metadata', type: 'custom', position: { x: 850, y: 520 }, data: { label: 'Metadata Service', sublabel: 'REST + WebSocket', icon: 'server', color: '#f59e0b' } },
  
  // Layer 6 Event Bus & Cache
  { id: 'kafka', type: 'custom', position: { x: 725, y: 680 }, data: { label: 'Kafka', sublabel: 'Internal Message Broker', icon: 'zap', color: '#ef4444' } },
  { id: 'redis', type: 'custom', position: { x: 1100, y: 680 }, data: { label: 'Redis', sublabel: 'Authenticated · Internal', icon: 'database', color: '#ef4444' } },
  
  // Layer 7 Workers
  { id: 'audit_worker', type: 'custom', position: { x: 100, y: 840 }, data: { label: 'Audit Logger', sublabel: 'Python Worker', icon: 'terminal', color: '#10b981' } },
  { id: 'zip_worker', type: 'custom', position: { x: 350, y: 840 }, data: { label: 'ZIP Extractor', sublabel: 'Quota + Safety Guards', icon: 'archive', color: '#10b981' } },
  { id: 'thumbnail_worker', type: 'custom', position: { x: 725, y: 840 }, data: { label: 'Thumbnail Gen', sublabel: 'Python Worker', icon: 'image', color: '#10b981' } },
  { id: 'search_worker', type: 'custom', position: { x: 975, y: 840 }, data: { label: 'Search Indexer', sublabel: 'Python Worker', icon: 'search', color: '#10b981' } },
  { id: 'notification_relay', type: 'custom', position: { x: 1225, y: 840 }, data: { label: 'Notification Relay', sublabel: 'Metadata Consumer', icon: 'bell', color: '#10b981' } },
  
  // Layer 8 Databases
  { id: 'mysql', type: 'custom', position: { x: 225, y: 1000 }, data: { label: 'MySQL', sublabel: 'Internal Relational DB', icon: 'database', color: '#ef4444' } },
  { id: 'minio', type: 'custom', position: { x: 500, y: 1000 }, data: { label: 'MinIO', sublabel: 'Loopback Admin Access', icon: 'database', color: '#ef4444' } },
  { id: 'elasticsearch', type: 'custom', position: { x: 975, y: 1000 }, data: { label: 'Elasticsearch', sublabel: 'Authenticated · Internal', icon: 'database', color: '#ef4444' } },
];

const defaultEdgeOptions = {
  animated: true,
  markerEnd: { type: MarkerType.ArrowClosed, color: '#94a3b8' },
  style: { strokeWidth: 2, stroke: '#94a3b8' },
  labelStyle: { fill: '#fff', fontWeight: 600, fontSize: 11 },
  labelBgStyle: { fill: '#1e293b', fillOpacity: 0.8 },
};

const blueLine = { strokeWidth: 2, stroke: '#3b82f6' };
const amberLine = { strokeWidth: 2, stroke: '#f59e0b' };
const greenLine = { strokeWidth: 2, stroke: '#10b981' };
const redLine = { strokeWidth: 2, stroke: '#ef4444' };
const dashedLine = { strokeDasharray: '5,5' };

const initialEdges = [
  // User -> Nginx
  { id: 'e-user-nginx', source: 'user', target: 'nginx', label: 'HTTP', ...defaultEdgeOptions, style: greenLine },
  
  // Nginx -> Web
  { id: 'e-nginx-web', source: 'nginx', target: 'web', label: 'proxy', ...defaultEdgeOptions, style: blueLine },
  
  // Web Layer
  { id: 'e-web-authctx', source: 'web', target: 'auth_context', label: '', ...defaultEdgeOptions, style: blueLine, type: 'smoothstep' },
  { id: 'e-web-api', source: 'web', target: 'api_client', label: 'requests', ...defaultEdgeOptions, style: blueLine, type: 'smoothstep' },
  
  { id: 'e-authctx-api', source: 'auth_context', target: 'api_client', label: 'auth state', ...defaultEdgeOptions, style: blueLine, type: 'smoothstep' },
  { id: 'e-preview-api', source: 'file_preview', target: 'api_client', label: 'download', ...defaultEdgeOptions, style: blueLine, type: 'smoothstep' },
  { id: 'e-share-api', source: 'share_ui', target: 'api_client', label: 'sharing', ...defaultEdgeOptions, style: blueLine, type: 'smoothstep' },
  
  { id: 'e-meta-notif', source: 'metadata', target: 'notifications', label: 'WebSocket push', ...defaultEdgeOptions, style: { ...blueLine, ...dashedLine }, type: 'smoothstep' },
  
  // API -> Services
  { id: 'e-api-auth', source: 'api_client', target: 'auth', label: 'REST', ...defaultEdgeOptions, style: amberLine, type: 'smoothstep' },
  { id: 'e-api-files', source: 'api_client', target: 'files', label: 'REST', ...defaultEdgeOptions, style: amberLine, type: 'smoothstep' },
  { id: 'e-api-meta', source: 'api_client', target: 'metadata', label: 'REST', ...defaultEdgeOptions, style: amberLine, type: 'smoothstep' },
  
  // Services
  { id: 'e-auth-mysql', source: 'auth', target: 'mysql', label: 'R/W', ...defaultEdgeOptions, type: 'smoothstep', style: amberLine },
  { id: 'e-auth-redis', source: 'auth', target: 'redis', label: 'write/check revocation', ...defaultEdgeOptions, style: { ...amberLine, ...dashedLine }, type: 'smoothstep' },
  
  { id: 'e-files-mysql', source: 'files', target: 'mysql', label: 'R/W', ...defaultEdgeOptions, type: 'smoothstep', style: amberLine },
  { id: 'e-files-minio', source: 'files', target: 'minio', label: 'stream objects', ...defaultEdgeOptions, type: 'smoothstep', style: amberLine },
  { id: 'e-files-kafka', source: 'files', target: 'kafka', label: 'publish events', ...defaultEdgeOptions, type: 'smoothstep', style: { strokeWidth: 3, stroke: '#f59e0b' } },
  { id: 'e-files-redis', source: 'files', target: 'redis', label: 'check revocation', ...defaultEdgeOptions, style: { ...amberLine, ...dashedLine }, type: 'smoothstep' },
  
  { id: 'e-meta-mysql', source: 'metadata', target: 'mysql', label: 'R/W', ...defaultEdgeOptions, type: 'smoothstep', style: amberLine },
  { id: 'e-meta-es', source: 'metadata', target: 'elasticsearch', label: 'authenticated query', ...defaultEdgeOptions, type: 'smoothstep', style: amberLine },
  { id: 'e-meta-redis', source: 'metadata', target: 'redis', label: 'JWT check + subscribe', ...defaultEdgeOptions, style: { ...amberLine, ...dashedLine }, type: 'smoothstep' },
  
  // Kafka -> Workers
  { id: 'e-kafka-audit', source: 'kafka', target: 'audit_worker', label: 'consume', ...defaultEdgeOptions, style: redLine, type: 'smoothstep' },
  { id: 'e-kafka-zip', source: 'kafka', target: 'zip_worker', label: 'consume', ...defaultEdgeOptions, style: redLine, type: 'smoothstep' },
  { id: 'e-kafka-thumb', source: 'kafka', target: 'thumbnail_worker', label: 'consume', ...defaultEdgeOptions, style: redLine },
  { id: 'e-kafka-search', source: 'kafka', target: 'search_worker', label: 'consume', ...defaultEdgeOptions, style: redLine, type: 'smoothstep' },
  { id: 'e-kafka-notify', source: 'kafka', target: 'notification_relay', label: 'consume events', ...defaultEdgeOptions, style: redLine, type: 'smoothstep' },
  
  // Workers -> DBs
  { id: 'e-audit-mysql', source: 'audit_worker', target: 'mysql', label: 'write audit', ...defaultEdgeOptions, style: greenLine, type: 'smoothstep' },
  
  { id: 'e-zip-minio', source: 'zip_worker', target: 'minio', label: 'read/store', ...defaultEdgeOptions, style: greenLine, type: 'smoothstep' },
  { id: 'e-zip-mysql', source: 'zip_worker', target: 'mysql', label: 'records + quota', ...defaultEdgeOptions, style: greenLine, type: 'smoothstep' },
  
  { id: 'e-thumb-minio', source: 'thumbnail_worker', target: 'minio', label: 'read/store', ...defaultEdgeOptions, style: greenLine, type: 'smoothstep' },
  { id: 'e-thumb-mysql', source: 'thumbnail_worker', target: 'mysql', label: 'update', ...defaultEdgeOptions, style: greenLine, type: 'smoothstep' },
  { id: 'e-thumb-redis', source: 'thumbnail_worker', target: 'redis', label: 'notify', ...defaultEdgeOptions, style: { ...greenLine, ...dashedLine }, type: 'smoothstep' },
  
  { id: 'e-search-minio', source: 'search_worker', target: 'minio', label: 'read content', ...defaultEdgeOptions, style: greenLine, type: 'smoothstep' },
  { id: 'e-search-es', source: 'search_worker', target: 'elasticsearch', label: 'least-privilege index', ...defaultEdgeOptions, style: greenLine, type: 'smoothstep' },
  { id: 'e-search-redis', source: 'search_worker', target: 'redis', label: 'notify', ...defaultEdgeOptions, style: { ...greenLine, ...dashedLine }, type: 'smoothstep' },
  { id: 'e-notify-redis', source: 'notification_relay', target: 'redis', label: 'publish activity', ...defaultEdgeOptions, style: { ...greenLine, ...dashedLine }, type: 'smoothstep' },
];

export default function ArchitectureTab() {
  const [nodes, setNodes] = useState(initialNodes);
  const [edges, setEdges] = useState(initialEdges);

  const onNodesChange = useCallback(
    (changes) => setNodes((nds) => applyNodeChanges(changes, nds)),
    []
  );
  const onEdgesChange = useCallback(
    (changes) => setEdges((eds) => applyEdgeChanges(changes, eds)),
    []
  );

  return (
    <div style={{ padding: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <div>
          <h2 style={{ fontSize: '24px', margin: '0 0 8px 0', fontWeight: 'bold' }}>CloudVault Architecture</h2>
          <p style={{ color: '#94a3b8', margin: 0 }}>
            Interactive System Topology. <span style={{ color: '#38bdf8' }}>Single-click</span> a node to inspect its role and exposure. <span style={{ color: '#ef4444' }}>Double-click</span> to simulate a health-state change.
          </p>
        </div>
      </div>

      {/* React Flow Canvas container */}
      <div style={{ height: '700px', width: '100%', background: '#0b0f19', borderRadius: '16px', border: '1px solid #1e293b', overflow: 'hidden' }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          fitView
          attributionPosition="bottom-left"
          defaultEdgeOptions={defaultEdgeOptions}
        >
          <Background variant="dots" gap={20} size={1} color="#334155" />
          <Controls style={{ background: '#1e293b', color: '#fff', fill: '#fff', border: '1px solid #334155' }} />
        </ReactFlow>
      </div>
      
      {/* CSS for pulse animation */}
      <style dangerouslySetInnerHTML={{__html: `
        @keyframes pulse {
          0% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.7); }
          70% { box-shadow: 0 0 0 10px rgba(239, 68, 68, 0); }
          100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0); }
        }
      `}} />
    </div>
  );
}
