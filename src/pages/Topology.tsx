import React, { useEffect, useState, useContext, useCallback } from 'react';
import { fetchWithAuth } from "../lib/api.js";
import { 
  Server, Database, Cloud, ArrowRight, ShieldCheck, Activity, 
  RefreshCw, Layers, Radio, Clock, AlertTriangle, CheckCircle2, 
  XCircle, Zap, ExternalLink, HardDrive, Info
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { SocketContext } from '../context/SocketContext.js';
import { useProject } from '../context/ProjectContext.js';

interface TopologyMetrics {
  requestCount: number;
  errorCount: number;
  errorRate: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  throughputRps: number;
  lastSeen?: string | null;
}

interface TopologyNode {
  id: string;
  type: 'client' | 'gateway' | 'upstream' | 'database' | 'queue';
  label: string;
  sublabel?: string;
  targetUrl?: string;
  pathPattern?: string;
  status: 'healthy' | 'degraded' | 'critical' | 'stale' | 'idle';
  lastSeen?: string | null;
  metrics: TopologyMetrics;
  metadata?: Record<string, any>;
}

interface TopologyEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  status: 'healthy' | 'degraded' | 'critical' | 'stale' | 'idle';
  metrics: TopologyMetrics;
}

interface TopologySnapshot {
  projectId: string;
  projectName?: string;
  generatedAt: string;
  timeWindowMinutes: number;
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  summary: {
    totalNodes: number;
    activeNodes: number;
    totalRequests: number;
    totalErrors: number;
    overallErrorRate: number;
    avgLatencyP95Ms: number;
    systemHealth: 'healthy' | 'degraded' | 'critical';
  };
}

export default function Topology() {
  const socketCtx = useContext(SocketContext);
  const { currentProject } = useProject();
  const [topology, setTopology] = useState<TopologySnapshot | null>(null);
  const [selectedNode, setSelectedNode] = useState<TopologyNode | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<TopologyEdge | null>(null);
  const [timeWindow, setTimeWindow] = useState<number>(15);
  const [loading, setLoading] = useState<boolean>(true);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const projectId = currentProject?.id || '';

  const fetchTopology = useCallback(async (showSpinner = false) => {
    if (!projectId) return;
    if (showSpinner) setIsRefreshing(true);
    try {
      const res = await fetchWithAuth(`/api/control/topology?projectId=${projectId}&window=${timeWindow}`);
      if (res.ok) {
        const data = await res.json();
        setTopology(data);
      }
    } catch (err) {
      console.error('Failed to fetch topology', err);
    } finally {
      setLoading(false);
      if (showSpinner) setIsRefreshing(false);
    }
  }, [projectId, timeWindow]);

  // Initial fetch and periodic polling fallback
  useEffect(() => {
    if (!projectId) return;
    fetchTopology();
    const interval = setInterval(() => fetchTopology(false), 5000);
    return () => clearInterval(interval);
  }, [projectId, timeWindow, fetchTopology]);

  // Socket.IO real-time event listener
  useEffect(() => {
    if (!socketCtx?.socket) return;
    const socket = socketCtx.socket;

    const handleTopologyUpdate = (snapshot: TopologySnapshot) => {
      if (snapshot && snapshot.projectId === projectId) {
        setTopology(snapshot);
      }
    };

    socket.on('telemetry:topology', handleTopologyUpdate);
    return () => {
      socket.off('telemetry:topology', handleTopologyUpdate);
    };
  }, [socketCtx?.socket, projectId]);

  const clientNode = topology?.nodes.find((n) => n.type === 'client');
  const gatewayNode = topology?.nodes.find((n) => n.type === 'gateway');
  const dbNode = topology?.nodes.find((n) => n.type === 'database');
  const queueNode = topology?.nodes.find((n) => n.type === 'queue');
  const upstreamNodes = topology?.nodes.filter((n) => n.type === 'upstream') || [];

  return (
    <div className="space-y-6 h-full flex flex-col">
      {/* Header & Controls */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 shrink-0">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-strong flex items-center gap-3">
            <Radio className="text-primary w-6 h-6 animate-pulse" />
            Dynamic Telemetry Topology
          </h2>
          <p className="text-xs text-muted mt-1">
            Real-time topology graph dynamically derived from live gateway traffic, upstream proxy metrics, and system telemetry.
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* Time Window Selector */}
          <div className="flex items-center bg-surface border border-subtle rounded-lg p-1 text-xs">
            <Clock className="w-3.5 h-3.5 text-muted ml-2 mr-1" />
            {[5, 15, 60].map((mins) => (
              <button
                key={mins}
                onClick={() => setTimeWindow(mins)}
                className={`px-2.5 py-1 rounded text-xs font-semibold transition ${
                  timeWindow === mins
                    ? 'bg-primary text-inverted'
                    : 'text-muted hover:text-strong'
                }`}
              >
                {mins < 60 ? `${mins}m` : '1h'}
              </button>
            ))}
          </div>

          {/* Refresh Button */}
          <button
            onClick={() => fetchTopology(true)}
            disabled={isRefreshing}
            className="p-2 border border-subtle rounded-lg bg-surface hover:bg-hover text-muted hover:text-strong transition"
            title="Refresh Topology"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin text-primary' : ''}`} />
          </button>

          {/* Live Status Badge */}
          <span className="text-[10px] font-mono text-muted border border-subtle px-3 py-1.5 rounded-lg bg-card flex items-center gap-2">
            <span
              className={`w-2 h-2 rounded-full ${
                topology?.summary.systemHealth === 'critical'
                  ? 'bg-red-500 animate-ping'
                  : topology?.summary.systemHealth === 'degraded'
                  ? 'bg-amber-500 animate-pulse'
                  : 'bg-green-500 animate-pulse'
              }`}
            ></span>
            {topology?.summary.systemHealth ? topology.summary.systemHealth.toUpperCase() : 'CONNECTING'}
          </span>
        </div>
      </div>

      {/* Summary KPI Bar */}
      {topology && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 shrink-0">
          <div className="bg-surface border border-subtle rounded-xl p-3">
            <div className="text-[10px] font-bold uppercase tracking-wider text-muted">Observed Ingress</div>
            <div className="text-xl font-bold text-strong mt-1">
              {topology.summary.totalRequests.toLocaleString()} <span className="text-xs text-muted font-normal">reqs</span>
            </div>
            <div className="text-[11px] text-muted mt-0.5 font-mono">
              {gatewayNode?.metrics.throughputRps || 0} req/s active
            </div>
          </div>

          <div className="bg-surface border border-subtle rounded-xl p-3">
            <div className="text-[10px] font-bold uppercase tracking-wider text-muted">Gateway P95 Latency</div>
            <div className="text-xl font-bold text-strong mt-1">
              {topology.summary.avgLatencyP95Ms} <span className="text-xs text-muted font-normal">ms</span>
            </div>
            <div className="text-[11px] text-muted mt-0.5 font-mono">
              p50: {gatewayNode?.metrics.p50LatencyMs || 0}ms
            </div>
          </div>

          <div className="bg-surface border border-subtle rounded-xl p-3">
            <div className="text-[10px] font-bold uppercase tracking-wider text-muted">Overall Error Rate</div>
            <div className={`text-xl font-bold mt-1 ${topology.summary.overallErrorRate > 5 ? 'text-red-400' : 'text-strong'}`}>
              {topology.summary.overallErrorRate}%
            </div>
            <div className="text-[11px] text-muted mt-0.5 font-mono">
              {topology.summary.totalErrors} total failures
            </div>
          </div>

          <div className="bg-surface border border-subtle rounded-xl p-3">
            <div className="text-[10px] font-bold uppercase tracking-wider text-muted">Discovered Services</div>
            <div className="text-xl font-bold text-strong mt-1">
              {upstreamNodes.length} <span className="text-xs text-muted font-normal">routes</span>
            </div>
            <div className="text-[11px] text-muted mt-0.5 font-mono">
              {topology.summary.activeNodes} active nodes
            </div>
          </div>
        </div>
      )}

      {/* Main Interactive Graph Viewport */}
      <div className="flex-1 bg-surface border border-subtle rounded-2xl p-6 md:p-10 flex items-center justify-center overflow-auto relative min-h-[480px]">
        {loading ? (
          <div className="flex flex-col items-center gap-3 text-muted">
            <RefreshCw className="w-8 h-8 animate-spin text-primary" />
            <span className="text-xs font-mono">Synthesizing live topology from telemetry logs...</span>
          </div>
        ) : (
          <div className="flex items-center gap-6 md:gap-14 min-w-max my-auto">
            {/* 1. Ingress Node */}
            {clientNode && (
              <InteractiveNode
                node={clientNode}
                icon={<Cloud size={28} />}
                isSelected={selectedNode?.id === clientNode.id}
                onClick={() => { setSelectedNode(clientNode); setSelectedEdge(null); }}
              />
            )}

            {/* Edge: Client -> Gateway */}
            <DirectedEdge
              label={gatewayNode?.metrics.throughputRps ? `${gatewayNode.metrics.throughputRps} rps` : 'idle'}
              status={gatewayNode?.status || 'idle'}
              active={Boolean(gatewayNode && gatewayNode.metrics.requestCount > 0)}
              onClick={() => {
                const edge = topology?.edges.find((e) => e.source === 'node-client');
                if (edge) { setSelectedEdge(edge); setSelectedNode(null); }
              }}
            />

            {/* 2. FortiX Gateway Core Node */}
            {gatewayNode && (
              <InteractiveNode
                node={gatewayNode}
                icon={<ShieldCheck size={28} />}
                highlight
                isSelected={selectedNode?.id === gatewayNode.id}
                onClick={() => { setSelectedNode(gatewayNode); setSelectedEdge(null); }}
              />
            )}

            {/* Upstream Branches & Infrastructure */}
            <div className="flex flex-col gap-8">
              {/* Upstream APIs Column */}
              <div className="flex flex-col gap-4">
                <div className="text-[10px] font-mono text-muted uppercase tracking-widest flex items-center gap-1.5 px-1">
                  <Layers className="w-3 h-3 text-primary" />
                  Protected Upstream Services ({upstreamNodes.length})
                </div>

                {upstreamNodes.length === 0 ? (
                  <div className="border border-dashed border-subtle rounded-xl p-4 text-center text-xs text-muted w-64 bg-card/50">
                    No routes configured yet. Add routes under APIs tab to monitor upstream targets.
                  </div>
                ) : (
                  upstreamNodes.map((routeNode) => (
                    <div key={routeNode.id} className="flex items-center gap-4">
                      <DirectedEdge
                        label={routeNode.metrics.throughputRps > 0 ? `${routeNode.metrics.throughputRps} rps` : 'idle'}
                        status={routeNode.status}
                        active={routeNode.metrics.requestCount > 0}
                        onClick={() => {
                          const edge = topology?.edges.find((e) => e.target === routeNode.id);
                          if (edge) { setSelectedEdge(edge); setSelectedNode(null); }
                        }}
                      />
                      <InteractiveNode
                        node={routeNode}
                        icon={<Server size={24} />}
                        isSelected={selectedNode?.id === routeNode.id}
                        onClick={() => { setSelectedNode(routeNode); setSelectedEdge(null); }}
                      />
                    </div>
                  ))
                )}
              </div>

              {/* Infrastructure Column (PostgreSQL + Redis/BullMQ) */}
              <div className="border-t border-subtle/80 pt-6 flex flex-col gap-4">
                <div className="text-[10px] font-mono text-muted uppercase tracking-widest flex items-center gap-1.5 px-1">
                  <HardDrive className="w-3 h-3 text-cyan-400" />
                  Telemetry & Persistence Engines
                </div>

                <div className="flex items-center gap-8">
                  {dbNode && (
                    <div className="flex items-center gap-4">
                      <DirectedEdge
                        label={`${dbNode.metadata?.latencyMs || 2}ms`}
                        status={dbNode.status}
                        active={true}
                        onClick={() => { setSelectedNode(dbNode); setSelectedEdge(null); }}
                      />
                      <InteractiveNode
                        node={dbNode}
                        icon={<Database size={24} />}
                        isSelected={selectedNode?.id === dbNode.id}
                        onClick={() => { setSelectedNode(dbNode); setSelectedEdge(null); }}
                      />
                    </div>
                  )}

                  {queueNode && (
                    <div className="flex items-center gap-4">
                      <DirectedEdge
                        label={`${queueNode.metadata?.latencyMs || 1}ms`}
                        status={queueNode.status}
                        active={true}
                        onClick={() => { setSelectedNode(queueNode); setSelectedEdge(null); }}
                      />
                      <InteractiveNode
                        node={queueNode}
                        icon={<Activity size={24} />}
                        isSelected={selectedNode?.id === queueNode.id}
                        onClick={() => { setSelectedNode(queueNode); setSelectedEdge(null); }}
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Selected Node / Edge Details Drawer */}
        <AnimatePresence>
          {(selectedNode || selectedEdge) && (
            <motion.div
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              className="absolute top-4 right-4 bottom-4 w-80 bg-base border border-subtle rounded-xl p-5 shadow-2xl z-30 flex flex-col overflow-y-auto"
            >
              <div className="flex items-center justify-between pb-3 border-b border-subtle mb-4">
                <div className="flex items-center gap-2">
                  <Info className="w-4 h-4 text-primary" />
                  <span className="text-xs font-bold uppercase tracking-wider text-strong">
                    {selectedNode ? 'Node Telemetry' : 'Edge Link Details'}
                  </span>
                </div>
                <button
                  onClick={() => { setSelectedNode(null); setSelectedEdge(null); }}
                  className="text-muted hover:text-strong text-xs p-1"
                >
                  ✕
                </button>
              </div>

              {selectedNode && (
                <div className="space-y-4 text-xs">
                  <div>
                    <div className="text-[10px] text-muted uppercase font-bold">Node Name</div>
                    <div className="text-sm font-bold text-strong mt-0.5">{selectedNode.label}</div>
                    {selectedNode.sublabel && (
                      <div className="text-[11px] text-muted font-mono mt-0.5 truncate">{selectedNode.sublabel}</div>
                    )}
                  </div>

                  <div>
                    <div className="text-[10px] text-muted uppercase font-bold">Status</div>
                    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-bold uppercase mt-1 ${
                      selectedNode.status === 'healthy' ? 'bg-green-500/10 text-green-400 border border-green-500/30' :
                      selectedNode.status === 'degraded' ? 'bg-amber-500/10 text-amber-400 border border-amber-500/30' :
                      selectedNode.status === 'critical' ? 'bg-red-500/10 text-red-400 border border-red-500/30' :
                      'bg-muted/10 text-muted border border-subtle'
                    }`}>
                      {selectedNode.status}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-2 pt-2 border-t border-subtle">
                    <div className="bg-surface p-2.5 rounded-lg border border-subtle">
                      <div className="text-[10px] text-muted">Total Reqs</div>
                      <div className="text-base font-bold text-strong mt-0.5 font-mono">
                        {selectedNode.metrics.requestCount.toLocaleString()}
                      </div>
                    </div>
                    <div className="bg-surface p-2.5 rounded-lg border border-subtle">
                      <div className="text-[10px] text-muted">Throughput</div>
                      <div className="text-base font-bold text-strong mt-0.5 font-mono">
                        {selectedNode.metrics.throughputRps} rps
                      </div>
                    </div>
                    <div className="bg-surface p-2.5 rounded-lg border border-subtle">
                      <div className="text-[10px] text-muted">P50 Latency</div>
                      <div className="text-base font-bold text-strong mt-0.5 font-mono">
                        {selectedNode.metrics.p50LatencyMs} ms
                      </div>
                    </div>
                    <div className="bg-surface p-2.5 rounded-lg border border-subtle">
                      <div className="text-[10px] text-muted">P95 Latency</div>
                      <div className="text-base font-bold text-strong mt-0.5 font-mono">
                        {selectedNode.metrics.p95LatencyMs} ms
                      </div>
                    </div>
                  </div>

                  {selectedNode.metrics.lastSeen && (
                    <div>
                      <div className="text-[10px] text-muted uppercase font-bold">Last Activity</div>
                      <div className="text-[11px] font-mono text-muted mt-0.5">
                        {new Date(selectedNode.metrics.lastSeen).toLocaleTimeString()}
                      </div>
                    </div>
                  )}

                  {selectedNode.metadata && (
                    <div className="pt-2 border-t border-subtle">
                      <div className="text-[10px] text-muted uppercase font-bold mb-1">Metadata</div>
                      <pre className="bg-surface p-2 rounded text-[10px] font-mono text-muted overflow-x-auto">
                        {JSON.stringify(selectedNode.metadata, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              )}

              {selectedEdge && (
                <div className="space-y-4 text-xs">
                  <div>
                    <div className="text-[10px] text-muted uppercase font-bold">Directed Link</div>
                    <div className="text-sm font-bold text-strong mt-0.5">
                      {selectedEdge.source} ➔ {selectedEdge.target}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2 pt-2 border-t border-subtle">
                    <div className="bg-surface p-2.5 rounded-lg border border-subtle">
                      <div className="text-[10px] text-muted">Edge Volume</div>
                      <div className="text-base font-bold text-strong mt-0.5 font-mono">
                        {selectedEdge.metrics.requestCount}
                      </div>
                    </div>
                    <div className="bg-surface p-2.5 rounded-lg border border-subtle">
                      <div className="text-[10px] text-muted">Rate</div>
                      <div className="text-base font-bold text-strong mt-0.5 font-mono">
                        {selectedEdge.metrics.throughputRps} rps
                      </div>
                    </div>
                    <div className="bg-surface p-2.5 rounded-lg border border-subtle">
                      <div className="text-[10px] text-muted">Error Count</div>
                      <div className="text-base font-bold text-red-400 mt-0.5 font-mono">
                        {selectedEdge.metrics.errorCount}
                      </div>
                    </div>
                    <div className="bg-surface p-2.5 rounded-lg border border-subtle">
                      <div className="text-[10px] text-muted">P95 Latency</div>
                      <div className="text-base font-bold text-strong mt-0.5 font-mono">
                        {selectedEdge.metrics.p95LatencyMs} ms
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function InteractiveNode({
  node,
  icon,
  highlight,
  isSelected,
  onClick,
}: {
  node: TopologyNode;
  icon: React.ReactNode;
  highlight?: boolean;
  isSelected?: boolean;
  onClick: () => void;
}) {
  let borderColor = 'border-subtle';
  let bgColor = 'bg-card';
  let textColor = 'text-strong';

  if (isSelected) {
    borderColor = 'border-primary ring-2 ring-primary/40';
    bgColor = 'bg-primary/15';
    textColor = 'text-primary';
  } else if (highlight) {
    borderColor = 'border-primary/80';
    bgColor = 'bg-primary/10';
    textColor = 'text-primary';
  } else if (node.status === 'critical') {
    borderColor = 'border-red-500/80';
    bgColor = 'bg-red-500/10';
    textColor = 'text-red-400';
  } else if (node.status === 'degraded') {
    borderColor = 'border-amber-500/80';
    bgColor = 'bg-amber-500/10';
    textColor = 'text-amber-400';
  } else if (node.status === 'stale') {
    borderColor = 'border-subtle/50';
    bgColor = 'bg-surface/50 opacity-60';
    textColor = 'text-muted';
  }

  return (
    <div
      onClick={onClick}
      className={`flex flex-col justify-between w-44 h-36 rounded-xl border ${borderColor} ${bgColor} p-3.5 relative z-10 cursor-pointer transition-all hover:scale-105 hover:shadow-xl group`}
    >
      {/* Top row: Icon + Status Pill */}
      <div className="flex items-center justify-between">
        <div className={textColor}>{icon}</div>
        <span
          className={`text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${
            node.status === 'healthy'
              ? 'bg-green-500/10 text-green-400 border-green-500/30'
              : node.status === 'degraded'
              ? 'bg-amber-500/10 text-amber-400 border-amber-500/30'
              : node.status === 'critical'
              ? 'bg-red-500/10 text-red-400 border-red-500/30 animate-pulse'
              : node.status === 'stale'
              ? 'bg-muted/10 text-muted border-subtle'
              : 'bg-surface text-muted border-subtle'
          }`}
        >
          {node.status}
        </span>
      </div>

      {/* Center: Label + Sublabel */}
      <div>
        <div className="text-xs font-bold text-strong truncate leading-tight group-hover:text-primary transition">
          {node.label}
        </div>
        {node.sublabel && (
          <div className="text-[10px] text-muted truncate mt-0.5 font-mono">
            {node.sublabel}
          </div>
        )}
      </div>

      {/* Bottom KPI strip */}
      <div className="flex items-center justify-between text-[10px] font-mono border-t border-subtle/60 pt-1.5 text-muted">
        <span>{node.metrics.throughputRps > 0 ? `${node.metrics.throughputRps} rps` : '0 rps'}</span>
        <span>{node.metrics.p95LatencyMs > 0 ? `${node.metrics.p95LatencyMs}ms` : '—'}</span>
      </div>
    </div>
  );
}

function DirectedEdge({
  label,
  status,
  active,
  onClick,
}: {
  label?: string;
  status?: string;
  active?: boolean;
  onClick?: () => void;
}) {
  const isProblem = status === 'critical' || status === 'degraded';

  return (
    <div
      onClick={onClick}
      className="relative flex flex-col items-center justify-center w-16 cursor-pointer group py-2"
    >
      {label && (
        <span className="text-[9px] font-mono text-muted mb-1 px-1.5 py-0.5 rounded bg-surface border border-subtle whitespace-nowrap z-20 group-hover:border-primary group-hover:text-primary transition">
          {label}
        </span>
      )}
      <div className="relative flex items-center justify-center w-full">
        <div
          className={`absolute w-full h-0.5 ${
            isProblem
              ? 'bg-amber-500'
              : active
              ? 'bg-primary'
              : 'bg-border'
          }`}
        ></div>
        <ArrowRight
          className={`w-5 h-5 shrink-0 relative z-10 bg-surface px-0.5 ${
            isProblem
              ? 'text-amber-400'
              : active
              ? 'text-primary'
              : 'text-muted'
          }`}
        />
      </div>
    </div>
  );
}
