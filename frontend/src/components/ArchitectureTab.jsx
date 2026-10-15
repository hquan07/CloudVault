import React, { useCallback, useEffect, useState } from 'react';
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
  Activity,
  Archive,
  Bell,
  Database,
  FileText,
  Folder,
  Globe,
  Image,
  Lock,
  Monitor,
  Search,
  Server,
  Share2,
  Shield,
  TerminalSquare,
  User,
  Zap,
} from 'lucide-react';

const nodeDetails = {
  user: { desc: 'Browser user', stat: 'JWT · UI · REST · WebSocket' },
  project_clients: { desc: 'Connected project uploaders', stat: 'E-commerce · News_Flow · Real-Time Stock' },
  shared_network: { desc: 'External Docker network', stat: 'Gateway alias: cloudvault-api' },
  nginx: { desc: 'Nginx Gateway', stat: 'Routing · rate limits · security headers' },
  web: { desc: 'Next.js 16 frontend', stat: 'Personal and project storage UI' },
  projects_ui: { desc: 'Projects UI', stat: 'Files · members · access · policy · activity' },
  account_security: { desc: 'Account Security UI', stat: 'Password · active sessions · revocation' },
  file_preview: { desc: 'Preview Component', stat: 'Media · PDF · text · JSON · XML · CSV' },
  notifications: { desc: 'Notification UI', stat: 'Authenticated WebSocket activity' },
  api_client: { desc: 'Same-origin API client', stat: 'JWT refresh · project requests · retry' },
  auth: { desc: 'FastAPI Auth replica group', stat: 'Identity limits · token rotation · security audit' },
  files: { desc: 'FastAPI File replica group', stat: 'Streaming · idempotency · quota reservation' },
  metadata: { desc: 'FastAPI Metadata replica group', stat: 'Sharing · search · activity · WebSocket' },
  mysql: { desc: 'MySQL 8', stat: 'Personal/project metadata and audit' },
  minio: { desc: 'MinIO object storage', stat: 'Development: 1 node · HA: 4 distributed nodes' },
  kafka: { desc: 'Apache Kafka', stat: 'Development: 1 broker · HA: 3 brokers, RF=3' },
  redis: { desc: 'Redis 7', stat: 'JWT revocation · auth limits · Pub/Sub' },
  elasticsearch: { desc: 'Elasticsearch 8.11', stat: 'Authenticated least-privilege search' },
  audit_worker: { desc: 'Scalable Audit Logger group', stat: 'Manual commit · retry · DLQ · event dedupe' },
  zip_worker: { desc: 'Scalable guarded ZIP group', stat: 'Archive limits · retry · DLQ · event dedupe' },
  thumbnail_worker: { desc: 'Scalable Thumbnail group', stat: 'Manual commit · retry · dead-letter topic' },
  search_worker: { desc: 'Scalable Search Indexer group', stat: 'Manual commit · retry · dead-letter topic' },
  notification_relay: { desc: 'Notification Relay consumer group', stat: 'Manual commit · retry · dead-letter topic' },
  project_ops: { desc: 'Project Operations', stat: 'Reconciliation · retention · metrics :9100' },
  mysql_migrate: { desc: 'One-shot migration job', stat: 'Ordered idempotent migrations 002–011' },
  prometheus: { desc: 'Prometheus', stat: 'Project quota and integrity metrics' },
  grafana: { desc: 'Grafana', stat: 'Project operations dashboard' },
  alertmanager: { desc: 'Alertmanager', stat: 'Quota · drift · object and worker alerts' },
  jaeger: { desc: 'Jaeger', stat: 'OpenTelemetry API traces' },
};

const iconMap = {
  activity: Activity,
  archive: Archive,
  bell: Bell,
  database: Database,
  filetext: FileText,
  folder: Folder,
  globe: Globe,
  image: Image,
  lock: Lock,
  monitor: Monitor,
  search: Search,
  server: Server,
  share: Share2,
  shield: Shield,
  terminal: TerminalSquare,
  user: User,
  zap: Zap,
};

const CustomNode = ({ id, data }) => {
  const [showDetails, setShowDetails] = useState(false);
  const health = data.health || 'documented';
  const isUnhealthy = health === 'unhealthy';
  const Icon = iconMap[data.icon] || Server;
  const details = nodeDetails[id] || { desc: 'System component', stat: 'Documented topology' };

  return (
    <div
      onClick={() => setShowDetails((current) => !current)}
      style={{
        padding: '11px 14px',
        borderRadius: '12px',
        background: isUnhealthy ? 'rgba(127, 29, 29, 0.92)' : 'rgba(30, 41, 59, 0.92)',
        border: `2px solid ${isUnhealthy ? '#ef4444' : data.color || '#475569'}`,
        color: '#fff',
        width: '190px',
        boxShadow: isUnhealthy ? '0 0 15px rgba(239, 68, 68, 0.7)' : '0 4px 6px -1px rgba(0, 0, 0, 0.3)',
        position: 'relative',
        transition: 'all 0.3s ease',
        cursor: 'pointer',
      }}
    >
      <Handle type="target" position={Position.Top} style={{ background: '#94a3b8' }} />

      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <div style={{ padding: '7px', background: 'rgba(255,255,255,0.1)', borderRadius: '8px', display: 'flex' }}>
          <Icon size={19} color={isUnhealthy ? '#fff' : data.color || '#fff'} />
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: '13px' }}>{data.label}</div>
          <div style={{ fontSize: '10px', color: '#cbd5e1' }}>{data.sublabel}</div>
        </div>
      </div>

      <div
        title={health === 'documented' ? 'Documented component' : `Health: ${health}`}
        style={{
          position: 'absolute',
          top: '-6px',
          right: '-6px',
          width: '14px',
          height: '14px',
          borderRadius: '50%',
          background: health === 'healthy' ? '#22c55e' : isUnhealthy ? '#ef4444' : '#64748b',
          border: '2px solid #0f172a',
          boxShadow: health === 'healthy' ? '0 0 8px #22c55e' : isUnhealthy ? '0 0 8px #ef4444' : 'none',
          animation: isUnhealthy ? 'pulse 1s infinite' : 'none',
        }}
      />

      {showDetails && (
        <div
          style={{
            position: 'absolute',
            top: '108%',
            left: 0,
            width: '220px',
            background: 'rgba(15, 23, 42, 0.98)',
            border: '1px solid #334155',
            borderRadius: '8px',
            padding: '10px',
            fontSize: '11px',
            zIndex: 50,
            boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.5)',
          }}
        >
          <div style={{ color: '#94a3b8', marginBottom: '4px' }}>{details.desc}</div>
          <div style={{ fontWeight: 'bold', color: '#38bdf8' }}>{details.stat}</div>
        </div>
      )}

      <Handle type="source" position={Position.Bottom} style={{ background: '#94a3b8' }} />
    </div>
  );
};

const nodeTypes = { custom: CustomNode };

const initialNodes = [
  // External actors
  { id: 'user', type: 'custom', position: { x: 260, y: 0 }, data: { label: 'Browser User', sublabel: 'JWT Client', icon: 'user', color: '#3b82f6' } },
  { id: 'project_clients', type: 'custom', position: { x: 900, y: 0 }, data: { label: 'Project Clients', sublabel: 'Service Token Uploaders', icon: 'server', color: '#8b5cf6' } },

  // Gateway and presentation
  { id: 'nginx', type: 'custom', position: { x: 420, y: 130 }, data: { label: 'Nginx Gateway', sublabel: 'Public / Shared Entry', icon: 'globe', color: '#10b981' } },
  { id: 'shared_network', type: 'custom', position: { x: 900, y: 130 }, data: { label: 'cloudvault-shared', sublabel: 'External Docker Network', icon: 'share', color: '#8b5cf6' } },
  { id: 'web', type: 'custom', position: { x: 120, y: 270 }, data: { label: 'Next.js App', sublabel: 'Web Application', icon: 'monitor', color: '#3b82f6' } },
  { id: 'projects_ui', type: 'custom', position: { x: 0, y: 400 }, data: { label: 'Projects UI', sublabel: 'Storage / Access / Policy', icon: 'folder', color: '#3b82f6' } },
  { id: 'file_preview', type: 'custom', position: { x: 220, y: 400 }, data: { label: 'File Preview', sublabel: 'Personal + Project Files', icon: 'filetext', color: '#3b82f6' } },
  { id: 'notifications', type: 'custom', position: { x: 440, y: 400 }, data: { label: 'Notifications', sublabel: 'WebSocket UI', icon: 'bell', color: '#3b82f6' } },
  { id: 'account_security', type: 'custom', position: { x: 660, y: 400 }, data: { label: 'Account Security', sublabel: 'Password + Sessions', icon: 'lock', color: '#3b82f6' } },
  { id: 'api_client', type: 'custom', position: { x: 660, y: 270 }, data: { label: 'API Client', sublabel: 'Same-Origin Requests', icon: 'activity', color: '#3b82f6' } },

  // API services
  { id: 'auth', type: 'custom', position: { x: 180, y: 550 }, data: { label: 'Auth Service', sublabel: 'Stateless Replica Group', icon: 'shield', color: '#f59e0b' } },
  { id: 'files', type: 'custom', position: { x: 470, y: 550 }, data: { label: 'File Service', sublabel: 'Stateless Replica Group', icon: 'folder', color: '#f59e0b' } },
  { id: 'metadata', type: 'custom', position: { x: 760, y: 550 }, data: { label: 'Metadata Service', sublabel: 'Stateless Replica Group', icon: 'server', color: '#f59e0b' } },

  // Data and messaging
  { id: 'mysql', type: 'custom', position: { x: 0, y: 710 }, data: { label: 'MySQL', sublabel: 'Relational Metadata', icon: 'database', color: '#ef4444' } },
  { id: 'minio', type: 'custom', position: { x: 220, y: 710 }, data: { label: 'MinIO', sublabel: '1 Dev / 4 HA Nodes', icon: 'database', color: '#ef4444' } },
  { id: 'kafka', type: 'custom', position: { x: 440, y: 710 }, data: { label: 'Kafka', sublabel: '1 Dev / 3 HA Brokers', icon: 'zap', color: '#ef4444' } },
  { id: 'redis', type: 'custom', position: { x: 660, y: 710 }, data: { label: 'Redis', sublabel: 'Revocation + Pub/Sub', icon: 'database', color: '#ef4444' } },
  { id: 'elasticsearch', type: 'custom', position: { x: 880, y: 710 }, data: { label: 'Elasticsearch', sublabel: 'Authenticated Search', icon: 'search', color: '#ef4444' } },
  { id: 'jaeger', type: 'custom', position: { x: 1100, y: 550 }, data: { label: 'Jaeger', sublabel: 'OpenTelemetry Traces', icon: 'search', color: '#06b6d4' } },

  // Workers
  { id: 'audit_worker', type: 'custom', position: { x: 0, y: 880 }, data: { label: 'Audit Logger', sublabel: 'Scalable Consumer Group', icon: 'terminal', color: '#10b981' } },
  { id: 'zip_worker', type: 'custom', position: { x: 220, y: 880 }, data: { label: 'ZIP Extractor', sublabel: 'Scalable Guarded Group', icon: 'archive', color: '#10b981' } },
  { id: 'thumbnail_worker', type: 'custom', position: { x: 440, y: 880 }, data: { label: 'Thumbnail Worker', sublabel: 'Scalable Consumer Group', icon: 'image', color: '#10b981' } },
  { id: 'search_worker', type: 'custom', position: { x: 660, y: 880 }, data: { label: 'Search Indexer', sublabel: 'Scalable Consumer Group', icon: 'search', color: '#10b981' } },
  { id: 'notification_relay', type: 'custom', position: { x: 880, y: 880 }, data: { label: 'Notification Relay', sublabel: 'Kafka → Redis', icon: 'bell', color: '#10b981' } },
  { id: 'project_ops', type: 'custom', position: { x: 1100, y: 880 }, data: { label: 'Project Operations', sublabel: 'Reconcile + Retention', icon: 'activity', color: '#10b981' } },

  // Migration and monitoring
  { id: 'mysql_migrate', type: 'custom', position: { x: 0, y: 1050 }, data: { label: 'MySQL Migrate', sublabel: 'One-Shot Job', icon: 'terminal', color: '#06b6d4' } },
  { id: 'grafana', type: 'custom', position: { x: 660, y: 1050 }, data: { label: 'Grafana', sublabel: 'Operations Dashboard', icon: 'activity', color: '#06b6d4' } },
  { id: 'prometheus', type: 'custom', position: { x: 880, y: 1050 }, data: { label: 'Prometheus', sublabel: 'Metrics + Rules', icon: 'activity', color: '#06b6d4' } },
  { id: 'alertmanager', type: 'custom', position: { x: 1100, y: 1050 }, data: { label: 'Alertmanager', sublabel: 'Operations Alerts', icon: 'bell', color: '#06b6d4' } },
];

const defaultEdgeOptions = {
  animated: true,
  markerEnd: { type: MarkerType.ArrowClosed, color: '#94a3b8' },
  style: { strokeWidth: 2, stroke: '#94a3b8' },
  labelStyle: { fill: '#fff', fontWeight: 600, fontSize: 10 },
  labelBgStyle: { fill: '#1e293b', fillOpacity: 0.85 },
};

const blueLine = { strokeWidth: 2, stroke: '#3b82f6' };
const amberLine = { strokeWidth: 2, stroke: '#f59e0b' };
const greenLine = { strokeWidth: 2, stroke: '#10b981' };
const purpleLine = { strokeWidth: 2, stroke: '#8b5cf6' };
const redLine = { strokeWidth: 2, stroke: '#ef4444' };
const cyanLine = { strokeWidth: 2, stroke: '#06b6d4' };
const dashedLine = { strokeDasharray: '5,5' };

const connectionLegend = [
  { label: 'UI / browser', color: '#3b82f6' },
  { label: 'External project integration', color: '#8b5cf6' },
  { label: 'Gateway / synchronous API', color: '#f59e0b' },
  { label: 'Kafka consumption', color: '#ef4444' },
  { label: 'Worker / data processing', color: '#10b981' },
  { label: 'Operations / observability', color: '#06b6d4' },
];

const initialEdges = [
  // Entry boundaries
  { id: 'e-user-nginx', source: 'user', target: 'nginx', label: 'UI / API / WS', ...defaultEdgeOptions, style: blueLine },
  { id: 'e-clients-shared', source: 'project_clients', target: 'shared_network', label: 'cvp_ service token', ...defaultEdgeOptions, style: purpleLine },
  { id: 'e-shared-nginx', source: 'shared_network', target: 'nginx', label: 'cloudvault-api', ...defaultEdgeOptions, style: purpleLine, type: 'smoothstep' },

  // Frontend and gateway routing
  { id: 'e-nginx-web', source: 'nginx', target: 'web', label: 'serve UI', ...defaultEdgeOptions, style: blueLine, type: 'smoothstep' },
  { id: 'e-web-projects', source: 'web', target: 'projects_ui', ...defaultEdgeOptions, style: blueLine, type: 'smoothstep' },
  { id: 'e-web-preview', source: 'web', target: 'file_preview', ...defaultEdgeOptions, style: blueLine, type: 'smoothstep' },
  { id: 'e-web-account-security', source: 'web', target: 'account_security', ...defaultEdgeOptions, style: blueLine, type: 'smoothstep' },
  { id: 'e-web-api', source: 'web', target: 'api_client', label: 'browser bundle', ...defaultEdgeOptions, style: blueLine, type: 'smoothstep' },
  { id: 'e-projects-api', source: 'projects_ui', target: 'api_client', label: 'project requests', ...defaultEdgeOptions, style: blueLine, type: 'smoothstep' },
  { id: 'e-preview-api', source: 'file_preview', target: 'api_client', label: 'preview / download', ...defaultEdgeOptions, style: blueLine, type: 'smoothstep' },
  { id: 'e-account-security-api', source: 'account_security', target: 'api_client', label: 'password / sessions', ...defaultEdgeOptions, style: blueLine, type: 'smoothstep' },
  { id: 'e-api-nginx', source: 'api_client', target: 'nginx', label: 'same-origin REST', ...defaultEdgeOptions, style: blueLine, type: 'smoothstep' },
  { id: 'e-nginx-auth', source: 'nginx', target: 'auth', label: 'auth / sessions / project access', ...defaultEdgeOptions, style: amberLine, type: 'smoothstep' },
  { id: 'e-nginx-files', source: 'nginx', target: 'files', label: 'file / folder routes', ...defaultEdgeOptions, style: amberLine, type: 'smoothstep' },
  { id: 'e-nginx-meta', source: 'nginx', target: 'metadata', label: 'metadata / search / WS', ...defaultEdgeOptions, style: amberLine, type: 'smoothstep' },
  { id: 'e-meta-notifications', source: 'metadata', target: 'notifications', label: 'WebSocket via gateway', ...defaultEdgeOptions, style: { ...blueLine, ...dashedLine }, type: 'smoothstep' },

  // API data dependencies
  { id: 'e-auth-mysql', source: 'auth', target: 'mysql', label: 'users / projects / audit', ...defaultEdgeOptions, style: amberLine, type: 'smoothstep' },
  { id: 'e-auth-redis', source: 'auth', target: 'redis', label: 'revocation / auth limits', ...defaultEdgeOptions, style: { ...amberLine, ...dashedLine }, type: 'smoothstep' },
  { id: 'e-files-mysql', source: 'files', target: 'mysql', label: 'metadata / quota', ...defaultEdgeOptions, style: amberLine, type: 'smoothstep' },
  { id: 'e-files-minio', source: 'files', target: 'minio', label: 'stream objects', ...defaultEdgeOptions, style: amberLine, type: 'smoothstep' },
  { id: 'e-files-kafka', source: 'files', target: 'kafka', label: 'publish events', ...defaultEdgeOptions, style: amberLine, type: 'smoothstep' },
  { id: 'e-files-redis', source: 'files', target: 'redis', label: 'JWT revocation', ...defaultEdgeOptions, style: { ...amberLine, ...dashedLine }, type: 'smoothstep' },
  { id: 'e-meta-mysql', source: 'metadata', target: 'mysql', label: 'metadata / activity', ...defaultEdgeOptions, style: amberLine, type: 'smoothstep' },
  { id: 'e-meta-es', source: 'metadata', target: 'elasticsearch', label: 'authenticated query', ...defaultEdgeOptions, style: amberLine, type: 'smoothstep' },
  { id: 'e-meta-redis', source: 'metadata', target: 'redis', label: 'revocation + subscribe', ...defaultEdgeOptions, style: { ...amberLine, ...dashedLine }, type: 'smoothstep' },

  // Event workers
  { id: 'e-kafka-audit', source: 'kafka', target: 'audit_worker', label: 'consume', ...defaultEdgeOptions, style: redLine, type: 'smoothstep' },
  { id: 'e-kafka-zip', source: 'kafka', target: 'zip_worker', label: 'consume', ...defaultEdgeOptions, style: redLine, type: 'smoothstep' },
  { id: 'e-kafka-thumb', source: 'kafka', target: 'thumbnail_worker', label: 'consume', ...defaultEdgeOptions, style: redLine, type: 'smoothstep' },
  { id: 'e-kafka-search', source: 'kafka', target: 'search_worker', label: 'consume', ...defaultEdgeOptions, style: redLine, type: 'smoothstep' },
  { id: 'e-kafka-relay', source: 'kafka', target: 'notification_relay', label: 'consume', ...defaultEdgeOptions, style: redLine, type: 'smoothstep' },
  { id: 'e-audit-mysql', source: 'audit_worker', target: 'mysql', label: 'write audit', ...defaultEdgeOptions, style: greenLine, type: 'smoothstep' },
  { id: 'e-zip-mysql', source: 'zip_worker', target: 'mysql', label: 'records + quota', ...defaultEdgeOptions, style: greenLine, type: 'smoothstep' },
  { id: 'e-zip-minio', source: 'zip_worker', target: 'minio', label: 'read / store', ...defaultEdgeOptions, style: greenLine, type: 'smoothstep' },
  { id: 'e-thumb-mysql', source: 'thumbnail_worker', target: 'mysql', label: 'update', ...defaultEdgeOptions, style: greenLine, type: 'smoothstep' },
  { id: 'e-thumb-minio', source: 'thumbnail_worker', target: 'minio', label: 'read / store', ...defaultEdgeOptions, style: greenLine, type: 'smoothstep' },
  { id: 'e-thumb-redis', source: 'thumbnail_worker', target: 'redis', label: 'notify', ...defaultEdgeOptions, style: { ...greenLine, ...dashedLine }, type: 'smoothstep' },
  { id: 'e-search-minio', source: 'search_worker', target: 'minio', label: 'read content', ...defaultEdgeOptions, style: greenLine, type: 'smoothstep' },
  { id: 'e-search-es', source: 'search_worker', target: 'elasticsearch', label: 'index', ...defaultEdgeOptions, style: greenLine, type: 'smoothstep' },
  { id: 'e-search-redis', source: 'search_worker', target: 'redis', label: 'notify', ...defaultEdgeOptions, style: { ...greenLine, ...dashedLine }, type: 'smoothstep' },
  { id: 'e-relay-redis', source: 'notification_relay', target: 'redis', label: 'publish activity', ...defaultEdgeOptions, style: { ...greenLine, ...dashedLine }, type: 'smoothstep' },

  // Operations, migrations and observability
  { id: 'e-migrate-mysql', source: 'mysql_migrate', target: 'mysql', label: 'migrations 002–011', ...defaultEdgeOptions, style: cyanLine, type: 'smoothstep' },
  { id: 'e-ops-mysql', source: 'project_ops', target: 'mysql', label: 'reconcile metadata', ...defaultEdgeOptions, style: greenLine, type: 'smoothstep' },
  { id: 'e-ops-minio', source: 'project_ops', target: 'minio', label: 'reconcile objects', ...defaultEdgeOptions, style: greenLine, type: 'smoothstep' },
  { id: 'e-prom-ops', source: 'prometheus', target: 'project_ops', label: 'scrape :9100', ...defaultEdgeOptions, style: cyanLine, type: 'smoothstep' },
  { id: 'e-grafana-prom', source: 'grafana', target: 'prometheus', label: 'query metrics', ...defaultEdgeOptions, style: cyanLine, type: 'smoothstep' },
  { id: 'e-prom-alerts', source: 'prometheus', target: 'alertmanager', label: 'firing alerts', ...defaultEdgeOptions, style: cyanLine, type: 'smoothstep' },
  { id: 'e-auth-jaeger', source: 'auth', target: 'jaeger', label: 'OTLP traces', ...defaultEdgeOptions, style: { ...cyanLine, ...dashedLine }, type: 'smoothstep' },
  { id: 'e-files-jaeger', source: 'files', target: 'jaeger', label: 'OTLP traces', ...defaultEdgeOptions, style: { ...cyanLine, ...dashedLine }, type: 'smoothstep' },
  { id: 'e-meta-jaeger', source: 'metadata', target: 'jaeger', label: 'OTLP traces', ...defaultEdgeOptions, style: { ...cyanLine, ...dashedLine }, type: 'smoothstep' },
];

export default function ArchitectureTab() {
  const [nodes, setNodes] = useState(initialNodes);
  const [edges, setEdges] = useState(initialEdges);
  const [lastChecked, setLastChecked] = useState(null);

  useEffect(() => {
    const checkHealth = async () => {
      const targets = {
        auth: '/health/auth',
        files: '/health/file',
        metadata: '/health/metadata',
      };
      const results = await Promise.all(
        Object.entries(targets).map(async ([id, url]) => {
          try {
            const response = await fetch(url, { cache: 'no-store' });
            return [id, response.ok ? 'healthy' : 'unhealthy'];
          } catch {
            return [id, 'unhealthy'];
          }
        }),
      );
      setNodes((current) => current.map((node) => {
        const result = results.find(([id]) => id === node.id);
        return result ? { ...node, data: { ...node.data, health: result[1] } } : node;
      }));
      setLastChecked(new Date());
    };

    void checkHealth();
    const timer = window.setInterval(checkHealth, 30000);
    return () => window.clearInterval(timer);
  }, []);

  const onNodesChange = useCallback(
    (changes) => setNodes((current) => applyNodeChanges(changes, current)),
    [],
  );
  const onEdgesChange = useCallback(
    (changes) => setEdges((current) => applyEdgeChanges(changes, current)),
    [],
  );

  return (
    <div style={{ padding: '24px' }}>
      <div className="mb-5 grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(680px,1.15fr)] xl:items-start">
        <div>
          <h2 style={{ fontSize: '24px', margin: '0 0 8px', fontWeight: 'bold' }}>CloudVault Architecture</h2>
          <p style={{ color: '#94a3b8', margin: 0 }}>
            Personal and project storage topology. Click a node to inspect its role.
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '14px', marginTop: '10px', color: '#94a3b8', fontSize: '12px' }}>
            <span>🟢 Live API health</span>
            <span>🔴 API health check failed</span>
            <span>⚪ Documented component</span>
          </div>
          <p className="mt-3 max-w-xl text-xs leading-5 text-slate-500">
            Live probes cover Auth, File and Metadata APIs only.
            {lastChecked && <> Last checked {lastChecked.toLocaleTimeString()}.</>}
          </p>
          <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
            <span className="rounded-full border border-slate-700 bg-slate-900 px-2.5 py-1 text-slate-300">Development: single-node data services</span>
            <span className="rounded-full border border-cyan-800/80 bg-cyan-950/30 px-2.5 py-1 text-cyan-300">HA: Kafka ×3 · MinIO ×4 · scalable workloads</span>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-700/80 bg-slate-900/75 p-4 shadow-lg shadow-black/20">
          <div className="mb-3 flex items-baseline justify-between gap-3 border-b border-slate-800 pb-3">
            <h3 className="text-sm font-semibold text-slate-100">Connection legend</h3>
            <span className="text-[10px] uppercase tracking-[0.18em] text-slate-500">9 conventions</span>
          </div>
          <div className="grid grid-cols-1 gap-x-5 gap-y-3 text-[11px] text-slate-300 sm:grid-cols-2 lg:grid-cols-3">
            {connectionLegend.map((item) => (
              <span key={item.label} className="inline-flex min-w-0 items-center gap-2">
                <span aria-hidden="true" className="inline-block w-6 shrink-0" style={{ borderTop: `3px solid ${item.color}` }} />
                <span className="leading-4">{item.label}</span>
              </span>
            ))}
            <span className="inline-flex min-w-0 items-center gap-2">
              <span aria-hidden="true" className="inline-block w-6 shrink-0 border-t-[3px] border-slate-400" />
              <span className="leading-4">Primary request / data path</span>
            </span>
            <span className="inline-flex min-w-0 items-center gap-2">
              <span aria-hidden="true" className="inline-block w-6 shrink-0 border-t-[3px] border-dashed border-slate-400" />
              <span className="leading-4">Notification / control / telemetry</span>
            </span>
            <span className="inline-flex min-w-0 items-center gap-2">
              <span aria-hidden="true" className="inline-flex w-6 shrink-0 items-center justify-center text-lg leading-none text-slate-400">→</span>
              <span className="leading-4">Arrow shows flow direction</span>
            </span>
          </div>
        </div>
      </div>

      <div style={{ height: '760px', width: '100%', background: '#0b0f19', borderRadius: '16px', border: '1px solid #1e293b', overflow: 'hidden' }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.12 }}
          minZoom={0.25}
          attributionPosition="bottom-left"
          defaultEdgeOptions={defaultEdgeOptions}
        >
          <Background variant="dots" gap={20} size={1} color="#334155" />
          <Controls style={{ background: '#1e293b', color: '#fff', fill: '#fff', border: '1px solid #334155' }} />
        </ReactFlow>
      </div>

      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes pulse {
          0% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.7); }
          70% { box-shadow: 0 0 0 10px rgba(239, 68, 68, 0); }
          100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0); }
        }
      ` }} />
    </div>
  );
}
