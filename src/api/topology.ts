import express from 'express';
import { requireProjectOwnership } from './projects.js';
import { db } from '../db/index.js';
import { apiRoutes, metricLogs, experiments, projects } from '../db/schema.js';
import { eq, inArray, gte, desc } from 'drizzle-orm';
import { percentile } from '../lib/math.js';
import { getDependenciesHealth } from './system.js';
import { broadcast } from '../socket.js';

export const topologyRouter = express.Router();

export interface TopologyNode {
  id: string;
  type: 'client' | 'gateway' | 'upstream' | 'database' | 'queue';
  label: string;
  sublabel?: string;
  targetUrl?: string;
  pathPattern?: string;
  status: 'healthy' | 'degraded' | 'critical' | 'stale' | 'idle';
  lastSeen?: string | null;
  metrics: {
    requestCount: number;
    errorCount: number;
    errorRate: number; // 0-100 percentage
    p50LatencyMs: number;
    p95LatencyMs: number;
    throughputRps: number;
  };
  metadata?: Record<string, any>;
}

export interface TopologyEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  status: 'healthy' | 'degraded' | 'critical' | 'stale' | 'idle';
  metrics: {
    requestCount: number;
    errorCount: number;
    errorRate: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
    throughputRps: number;
    lastSeen: string | null;
  };
}

export interface TopologySnapshot {
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

/**
 * Aggregates real telemetry and route infrastructure into a dynamic topology graph
 */
export async function generateProjectTopology(
  projectId: string,
  timeWindowMinutes = 15
): Promise<TopologySnapshot> {
  const windowStart = new Date(Date.now() - timeWindowMinutes * 60 * 1000);
  const now = new Date();

  // 1. Fetch project info
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  // 2. Fetch routes for the project
  const routes = await db
    .select()
    .from(apiRoutes)
    .where(eq(apiRoutes.projectId, projectId));

  // 3. Fetch active experiments for routes
  const routeIds = routes.map((r) => r.id);
  let activeExperiments: any[] = [];
  if (routeIds.length > 0) {
    const exps = await db
      .select()
      .from(experiments)
      .where(inArray(experiments.routeId, routeIds));
    activeExperiments = exps.filter(
      (e) => e.status === 'RUNNING' || e.status === 'QUEUED' || e.status === 'ANALYZING'
    );
  }

  // 4. Check infrastructure dependencies health
  const health = await getDependenciesHealth();
  const dbStatus = (health.postgres.status === 'up' || health.postgres.status === 'healthy') ? 'healthy' : 'critical';
  const redisStatus = (health.redis.status === 'up' || health.redis.status === 'healthy') ? 'healthy' : 'critical';

  // 5. Query real telemetry for routes in the time window
  let metrics: Array<{
    id: string;
    routeId: string;
    latencyMs: number;
    statusCode: number;
    timestamp: Date;
    experimentId: string | null;
  }> = [];

  if (routeIds.length > 0) {
    metrics = await db
      .select({
        id: metricLogs.id,
        routeId: metricLogs.routeId,
        latencyMs: metricLogs.latencyMs,
        statusCode: metricLogs.statusCode,
        timestamp: metricLogs.timestamp,
        experimentId: metricLogs.experimentId,
      })
      .from(metricLogs)
      .where(inArray(metricLogs.routeId, routeIds))
      .orderBy(desc(metricLogs.timestamp))
      .limit(5000);
  }

  // Filter metrics to window for aggregation
  const windowMetrics = metrics.filter((m) => new Date(m.timestamp) >= windowStart);

  // Per-route metrics aggregation
  const routeMetricsMap = new Map<
    string,
    {
      items: typeof windowMetrics;
      allTimeCount: number;
      lastItem: (typeof metrics)[0] | undefined;
    }
  >();

  routes.forEach((route) => {
    const routeWindowItems = windowMetrics.filter((m) => m.routeId === route.id);
    const routeAllItems = metrics.filter((m) => m.routeId === route.id);
    routeMetricsMap.set(route.id, {
      items: routeWindowItems,
      allTimeCount: routeAllItems.length,
      lastItem: routeAllItems[0], // ordered by timestamp desc
    });
  });

  // Calculate totals
  let totalGatewayRequests = windowMetrics.length;
  let totalGatewayErrors = windowMetrics.filter((m) => m.statusCode >= 400).length;
  const gatewayLatencies = windowMetrics.map((m) => m.latencyMs);
  const gatewayP50 = gatewayLatencies.length > 0 ? percentile(gatewayLatencies, 0.5) : 0;
  const gatewayP95 = gatewayLatencies.length > 0 ? percentile(gatewayLatencies, 0.95) : 0;
  const gatewayErrorRate =
    totalGatewayRequests > 0
      ? Math.round((totalGatewayErrors / totalGatewayRequests) * 1000) / 10
      : 0;

  const windowSeconds = timeWindowMinutes * 60;
  const gatewayRps =
    totalGatewayRequests > 0
      ? Math.round((totalGatewayRequests / Math.min(windowSeconds, 60)) * 10) / 10
      : 0;

  const gatewayStatus: TopologyNode['status'] =
    activeExperiments.length > 0
      ? 'degraded'
      : gatewayErrorRate > 15
      ? 'critical'
      : gatewayErrorRate > 2
      ? 'degraded'
      : 'healthy';

  // Build Nodes
  const nodes: TopologyNode[] = [
    {
      id: 'node-client',
      type: 'client',
      label: 'Client Ingress',
      sublabel: 'External HTTP / API Clients',
      status: totalGatewayRequests > 0 ? 'healthy' : 'idle',
      lastSeen: windowMetrics[0]?.timestamp?.toISOString() || null,
      metrics: {
        requestCount: totalGatewayRequests,
        errorCount: totalGatewayErrors,
        errorRate: gatewayErrorRate,
        p50LatencyMs: gatewayP50,
        p95LatencyMs: gatewayP95,
        throughputRps: gatewayRps,
      },
    },
    {
      id: 'node-gateway',
      type: 'gateway',
      label: 'FortiX Security Gateway',
      sublabel: 'SSRF, Auth, WAF & Rate Limiter',
      status: gatewayStatus,
      lastSeen: now.toISOString(),
      metrics: {
        requestCount: totalGatewayRequests,
        errorCount: totalGatewayErrors,
        errorRate: gatewayErrorRate,
        p50LatencyMs: gatewayP50,
        p95LatencyMs: gatewayP95,
        throughputRps: gatewayRps,
      },
      metadata: {
        activeExperiments: activeExperiments.length,
        version: '1.0.0',
        environment: project?.environment || 'development',
      },
    },
    {
      id: 'node-db',
      type: 'database',
      label: 'PostgreSQL Database',
      sublabel: 'Telemetry, Policies, Audit Logs',
      status: dbStatus,
      lastSeen: now.toISOString(),
      metrics: {
        requestCount: totalGatewayRequests,
        errorCount: dbStatus === 'healthy' ? 0 : 1,
        errorRate: dbStatus === 'healthy' ? 0 : 100,
        p50LatencyMs: 2,
        p95LatencyMs: 8,
        throughputRps: gatewayRps,
      },
      metadata: {
        latencyMs: health.postgres.latencyMs,
      },
    },
    {
      id: 'node-queue',
      type: 'queue',
      label: 'Redis & BullMQ Engine',
      sublabel: 'Token Bucket & Worker Queues',
      status: redisStatus,
      lastSeen: now.toISOString(),
      metrics: {
        requestCount: totalGatewayRequests,
        errorCount: redisStatus === 'healthy' ? 0 : 1,
        errorRate: redisStatus === 'healthy' ? 0 : 100,
        p50LatencyMs: 1,
        p95LatencyMs: 4,
        throughputRps: gatewayRps,
      },
      metadata: {
        latencyMs: health.redis.latencyMs,
      },
    },
  ];

  // Upstream Service Nodes & Directed Edges
  const edges: TopologyEdge[] = [];

  // Client -> Gateway Edge
  edges.push({
    id: 'edge-client-gateway',
    source: 'node-client',
    target: 'node-gateway',
    label: totalGatewayRequests > 0 ? `${gatewayRps} rps` : 'idle',
    status: totalGatewayRequests === 0 ? 'idle' : gatewayStatus,
    metrics: {
      requestCount: totalGatewayRequests,
      errorCount: totalGatewayErrors,
      errorRate: gatewayErrorRate,
      p50LatencyMs: gatewayP50,
      p95LatencyMs: gatewayP95,
      throughputRps: gatewayRps,
      lastSeen: windowMetrics[0]?.timestamp?.toISOString() || null,
    },
  });

  // Gateway -> Database Edge
  edges.push({
    id: 'edge-gateway-db',
    source: 'node-gateway',
    target: 'node-db',
    label: `${health.postgres.latencyMs}ms`,
    status: dbStatus,
    metrics: {
      requestCount: totalGatewayRequests,
      errorCount: dbStatus === 'healthy' ? 0 : 1,
      errorRate: dbStatus === 'healthy' ? 0 : 100,
      p50LatencyMs: health.postgres.latencyMs || 2,
      p95LatencyMs: (health.postgres.latencyMs || 2) * 2,
      throughputRps: gatewayRps,
      lastSeen: now.toISOString(),
    },
  });

  // Gateway -> Redis Edge
  edges.push({
    id: 'edge-gateway-queue',
    source: 'node-gateway',
    target: 'node-queue',
    label: `${health.redis.latencyMs}ms`,
    status: redisStatus,
    metrics: {
      requestCount: totalGatewayRequests,
      errorCount: redisStatus === 'healthy' ? 0 : 1,
      errorRate: redisStatus === 'healthy' ? 0 : 100,
      p50LatencyMs: health.redis.latencyMs || 1,
      p95LatencyMs: (health.redis.latencyMs || 1) * 2,
      throughputRps: gatewayRps,
      lastSeen: now.toISOString(),
    },
  });

  // Process Each Route / Upstream
  routes.forEach((route) => {
    const { items, allTimeCount, lastItem } = routeMetricsMap.get(route.id)!;
    const reqCount = items.length;
    const errCount = items.filter((m) => m.statusCode >= 400).length;
    const errRate =
      reqCount > 0 ? Math.round((errCount / reqCount) * 1000) / 10 : 0;
    const latencies = items.map((m) => m.latencyMs);
    const p50 = latencies.length > 0 ? percentile(latencies, 0.5) : 0;
    const p95 = latencies.length > 0 ? percentile(latencies, 0.95) : 0;
    const rps =
      reqCount > 0 ? Math.round((reqCount / Math.min(windowSeconds, 60)) * 10) / 10 : 0;

    const lastSeenDate = lastItem?.timestamp ? new Date(lastItem.timestamp) : null;
    const isStale = lastSeenDate
      ? now.getTime() - lastSeenDate.getTime() > 2 * 60 * 1000
      : true;

    const hasRouteFault = activeExperiments.some((e) => e.routeId === route.id);

    let nodeStatus: TopologyNode['status'] = 'idle';
    if (hasRouteFault) {
      nodeStatus = 'degraded';
    } else if (reqCount > 0) {
      if (errRate >= 20) nodeStatus = 'critical';
      else if (errRate >= 5) nodeStatus = 'degraded';
      else nodeStatus = 'healthy';
    } else if (allTimeCount > 0 && isStale) {
      nodeStatus = 'stale';
    }

    const nodeId = `node-route-${route.id}`;
    nodes.push({
      id: nodeId,
      type: 'upstream',
      label: route.pathPattern || 'API Route',
      sublabel: route.targetUrl,
      targetUrl: route.targetUrl,
      pathPattern: route.pathPattern,
      status: nodeStatus,
      lastSeen: lastSeenDate ? lastSeenDate.toISOString() : null,
      metrics: {
        requestCount: reqCount,
        errorCount: errCount,
        errorRate: errRate,
        p50LatencyMs: p50,
        p95LatencyMs: p95,
        throughputRps: rps,
      },
      metadata: {
        routeId: route.id,
        hasActiveFault: hasRouteFault,
        allTimeRequests: allTimeCount,
      },
    });

    // Gateway -> Upstream Edge
    edges.push({
      id: `edge-gateway-route-${route.id}`,
      source: 'node-gateway',
      target: nodeId,
      label: reqCount > 0 ? `${rps} rps | p95 ${p95}ms` : 'idle',
      status: nodeStatus,
      metrics: {
        requestCount: reqCount,
        errorCount: errCount,
        errorRate: errRate,
        p50LatencyMs: p50,
        p95LatencyMs: p95,
        throughputRps: rps,
        lastSeen: lastSeenDate ? lastSeenDate.toISOString() : null,
      },
    });
  });

  const activeNodesCount = nodes.filter(
    (n) => n.status === 'healthy' || n.status === 'degraded' || n.status === 'critical'
  ).length;

  const systemHealth: TopologySnapshot['summary']['systemHealth'] =
    dbStatus === 'critical' || redisStatus === 'critical' || gatewayErrorRate > 20
      ? 'critical'
      : gatewayErrorRate > 5 || activeExperiments.length > 0
      ? 'degraded'
      : 'healthy';

  return {
    projectId,
    projectName: project?.name,
    generatedAt: now.toISOString(),
    timeWindowMinutes,
    nodes,
    edges,
    summary: {
      totalNodes: nodes.length,
      activeNodes: activeNodesCount,
      totalRequests: totalGatewayRequests,
      totalErrors: totalGatewayErrors,
      overallErrorRate: gatewayErrorRate,
      avgLatencyP95Ms: gatewayP95,
      systemHealth,
    },
  };
}

/**
 * Pushes updated topology data over Socket.IO room for the project
 */
export async function broadcastTopologyUpdate(projectId: string) {
  try {
    const topology = await generateProjectTopology(projectId);
    broadcast(projectId, 'telemetry:topology', topology);
  } catch (err) {
    // Non-fatal broadcast failure
  }
}

// REST Endpoints
topologyRouter.get('/', requireProjectOwnership, async (req, res) => {
  const projectId = req.query.projectId as string;
  const windowMins = parseInt(req.query.window as string, 10) || 15;

  try {
    const snapshot = await generateProjectTopology(projectId, windowMins);
    res.json(snapshot);
  } catch (error) {
    console.error('[Topology API] Error generating topology:', error);
    res.status(500).json({ error: 'Failed to generate telemetry topology' });
  }
});
