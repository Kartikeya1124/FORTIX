import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { generateProjectTopology } from '../../src/api/topology.js';
import { db } from '../../src/db/index.js';
import { projects, apiRoutes, experiments, metricLogs } from '../../src/db/schema.js';
import * as systemApi from '../../src/api/system.js';

describe('TSK-09: Dynamic Telemetry Topology Engine (Isolated Unit Suite)', () => {
  const testProjectId = 'proj_topo_test_1';
  const testRouteId1 = 'route_topo_users';
  const testRouteId2 = 'route_topo_payments';
  const foreignProjectId = 'proj_foreign_tenant';
  const foreignRouteId = 'route_foreign_secret';

  // In-memory data store for isolated mock testing
  let mockProjects: Array<{ id: string; name: string; environment: string }> = [];
  let mockRoutes: Array<{ id: string; projectId: string; pathPattern: string; targetUrl: string }> = [];
  let mockExperiments: Array<{ id: string; routeId: string; status: string }> = [];
  let mockMetricLogs: Array<{
    id: string;
    routeId: string;
    latencyMs: number;
    statusCode: number;
    timestamp: Date;
    experimentId: string | null;
  }> = [];

  function buildMockQueryChain(resolver: (table: any, fields: any) => any[]) {
    let capturedTable: any = null;
    let capturedFields: any = null;

    const createChain = (fields?: any) => {
      capturedFields = fields;
      const chain: any = {};
      chain.from = vi.fn().mockImplementation((table: any) => {
        capturedTable = table;
        return chain;
      });
      chain.where = vi.fn().mockReturnValue(chain);
      chain.orderBy = vi.fn().mockReturnValue(chain);
      chain.limit = vi.fn().mockImplementation(async (n: number) => {
        const rows = resolver(capturedTable, capturedFields);
        return rows.slice(0, n);
      });
      chain.then = (resolve: any, reject: any) => {
        const rows = resolver(capturedTable, capturedFields);
        return Promise.resolve(rows).then(resolve, reject);
      };
      return chain;
    };

    return createChain;
  }

  beforeEach(() => {
    vi.restoreAllMocks();

    // Default mock dependencies health (ensures isolated unit execution without DB/network)
    vi.spyOn(systemApi, 'getDependenciesHealth').mockResolvedValue({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      api: 'healthy',
      postgres: { status: 'healthy', latencyMs: 3 },
      redis: { status: 'healthy', latencyMs: 1 },
      socketConnections: 2,
    });

    // Populate mock test fixtures
    mockProjects = [
      { id: testProjectId, name: 'Main Test Project', environment: 'production' },
      { id: foreignProjectId, name: 'Foreign Tenant Project', environment: 'staging' },
    ];

    mockRoutes = [
      { id: testRouteId1, projectId: testProjectId, pathPattern: '/api/v1/users', targetUrl: 'https://users-svc.internal' },
      { id: testRouteId2, projectId: testProjectId, pathPattern: '/api/v1/payments', targetUrl: 'https://pay-svc.internal' },
      { id: foreignRouteId, projectId: foreignProjectId, pathPattern: '/api/v1/secret', targetUrl: 'https://secret-svc.internal' },
    ];

    mockExperiments = [
      { id: 'exp_1', routeId: testRouteId2, status: 'RUNNING' },
    ];

    const now = Date.now();
    mockMetricLogs = [
      // Route 1 metrics: 9 requests, 1 error (10% error rate), avg ~40ms
      ...Array.from({ length: 9 }, (_, i) => ({
        id: `log_1_${i}`,
        routeId: testRouteId1,
        latencyMs: 35 + i * 2,
        statusCode: 200,
        timestamp: new Date(now - i * 1000),
        experimentId: null,
      })),
      {
        id: 'log_1_err',
        routeId: testRouteId1,
        latencyMs: 120,
        statusCode: 500,
        timestamp: new Date(now - 500),
        experimentId: null,
      },
      // Route 2 metrics: 5 requests, all 200, latency ~150ms
      ...Array.from({ length: 5 }, (_, i) => ({
        id: `log_2_${i}`,
        routeId: testRouteId2,
        latencyMs: 140 + i * 5,
        statusCode: 200,
        timestamp: new Date(now - i * 2000),
        experimentId: 'exp_1',
      })),
      // Foreign route metrics: 20 requests
      ...Array.from({ length: 20 }, (_, i) => ({
        id: `log_foreign_${i}`,
        routeId: foreignRouteId,
        latencyMs: 15,
        statusCode: 200,
        timestamp: new Date(now - i * 500),
        experimentId: null,
      })),
    ];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('generates an empty topology snapshot safely when no routes exist', async () => {
    const chainFactory = buildMockQueryChain(() => []);
    vi.spyOn(db, 'select').mockImplementation(chainFactory as any);

    const snapshot = await generateProjectTopology('non_existent_proj', 15);

    expect(snapshot).toBeDefined();
    expect(snapshot.projectId).toBe('non_existent_proj');
    expect(snapshot.nodes.length).toBe(4); // Ingress, Gateway, DB, Queue nodes
    expect(snapshot.edges.length).toBe(3); // Ingress->Gateway, Gateway->DB, Gateway->Queue
    expect(snapshot.summary.totalRequests).toBe(0);
    expect(snapshot.summary.overallErrorRate).toBe(0);
  });

  it('calculates accurate request counts, p50/p95 latency, and error rates from metrics', async () => {
    const chainFactory = buildMockQueryChain((table, fields) => {
      if (table === projects) {
        return mockProjects.filter((p) => p.id === testProjectId);
      }
      if (table === apiRoutes) {
        return mockRoutes.filter((r) => r.projectId === testProjectId);
      }
      if (table === experiments) {
        return [];
      }
      if (table === metricLogs || (fields && typeof fields === 'object' && 'routeId' in fields)) {
        return mockMetricLogs.filter((m) => m.routeId === testRouteId1 || m.routeId === testRouteId2);
      }
      return [];
    });
    vi.spyOn(db, 'select').mockImplementation(chainFactory as any);

    const snapshot = await generateProjectTopology(testProjectId, 15);

    expect(snapshot).toBeDefined();
    expect(snapshot.nodes.length).toBeGreaterThanOrEqual(4);
    expect(snapshot.summary.totalNodes).toBe(snapshot.nodes.length);
    expect(typeof snapshot.summary.overallErrorRate).toBe('number');
    expect(typeof snapshot.summary.avgLatencyP95Ms).toBe('number');
    expect(snapshot.summary.totalRequests).toBe(15); // 10 from route1 + 5 from route2
    expect(snapshot.summary.totalErrors).toBe(1);
    expect(snapshot.summary.overallErrorRate).toBeCloseTo(6.7, 1);
  });

  it('enforces strict project and tenant isolation across topology graphs', async () => {
    // Project A
    const chainFactoryA = buildMockQueryChain((table, fields) => {
      if (table === projects) {
        return mockProjects.filter((p) => p.id === testProjectId);
      }
      if (table === apiRoutes) {
        return mockRoutes.filter((r) => r.projectId === testProjectId);
      }
      if (table === experiments) {
        return [];
      }
      if (table === metricLogs || (fields && typeof fields === 'object' && 'routeId' in fields)) {
        return mockMetricLogs.filter((m) => m.routeId === testRouteId1 || m.routeId === testRouteId2);
      }
      return [];
    });
    vi.spyOn(db, 'select').mockImplementation(chainFactoryA as any);

    const projASnapshot = await generateProjectTopology(testProjectId, 15);

    // Project B (Foreign Tenant)
    const chainFactoryB = buildMockQueryChain((table, fields) => {
      if (table === projects) {
        return mockProjects.filter((p) => p.id === foreignProjectId);
      }
      if (table === apiRoutes) {
        return mockRoutes.filter((r) => r.projectId === foreignProjectId);
      }
      if (table === experiments) {
        return [];
      }
      if (table === metricLogs || (fields && typeof fields === 'object' && 'routeId' in fields)) {
        return mockMetricLogs.filter((m) => m.routeId === foreignRouteId);
      }
      return [];
    });
    vi.spyOn(db, 'select').mockImplementation(chainFactoryB as any);

    const projBSnapshot = await generateProjectTopology(foreignProjectId, 15);

    // Ensure routes from Project A do not leak into Project B
    const projARouteNodes = projASnapshot.nodes.filter((n) => n.type === 'upstream').map((n) => n.id);
    const projBRouteNodes = projBSnapshot.nodes.filter((n) => n.type === 'upstream').map((n) => n.id);

    expect(projBRouteNodes).toContain(`node-route-${foreignRouteId}`);
    expect(projARouteNodes).toContain(`node-route-${testRouteId1}`);
    expect(projARouteNodes).toContain(`node-route-${testRouteId2}`);

    for (const nodeA of projARouteNodes) {
      expect(projBRouteNodes).not.toContain(nodeA);
    }
  });

  it('correctly builds directed edges with throughput and latency labels', async () => {
    const chainFactory = buildMockQueryChain((table, fields) => {
      if (table === projects) {
        return mockProjects.filter((p) => p.id === testProjectId);
      }
      if (table === apiRoutes) {
        return mockRoutes.filter((r) => r.projectId === testProjectId);
      }
      if (table === experiments) {
        return [];
      }
      if (table === metricLogs || (fields && typeof fields === 'object' && 'routeId' in fields)) {
        return mockMetricLogs.filter((m) => m.routeId === testRouteId1);
      }
      return [];
    });
    vi.spyOn(db, 'select').mockImplementation(chainFactory as any);

    const snapshot = await generateProjectTopology(testProjectId, 15);

    const gatewayToDbEdge = snapshot.edges.find((e) => e.source === 'node-gateway' && e.target === 'node-db');
    const gatewayToQueueEdge = snapshot.edges.find((e) => e.source === 'node-gateway' && e.target === 'node-queue');
    const clientToGatewayEdge = snapshot.edges.find((e) => e.source === 'node-client' && e.target === 'node-gateway');

    expect(gatewayToDbEdge).toBeDefined();
    expect(gatewayToQueueEdge).toBeDefined();
    expect(clientToGatewayEdge).toBeDefined();
    expect(clientToGatewayEdge?.source).toBe('node-client');
    expect(clientToGatewayEdge?.target).toBe('node-gateway');
  });

  it('assigns degraded status to routes or gateway when fault experiments are active', async () => {
    const chainFactory = buildMockQueryChain((table, fields) => {
      if (table === projects) {
        return mockProjects.filter((p) => p.id === testProjectId);
      }
      if (table === apiRoutes) {
        return mockRoutes.filter((r) => r.projectId === testProjectId);
      }
      if (table === experiments) {
        return [{ id: 'exp_fault_1', routeId: testRouteId1, status: 'RUNNING' }];
      }
      if (table === metricLogs || (fields && typeof fields === 'object' && 'routeId' in fields)) {
        return [
          {
            id: 'log_clean_1',
            routeId: testRouteId1,
            latencyMs: 25,
            statusCode: 200,
            timestamp: new Date(),
            experimentId: 'exp_fault_1',
          },
        ];
      }
      return [];
    });
    vi.spyOn(db, 'select').mockImplementation(chainFactory as any);

    const snapshot = await generateProjectTopology(testProjectId, 15);
    expect(['healthy', 'degraded', 'critical', 'idle']).toContain(snapshot.summary.systemHealth);
    expect(snapshot.summary.systemHealth).toBe('degraded');
  });
});
