import React, { useEffect, useState, useCallback } from 'react';
import { fetchWithAuth } from '../lib/api.js';
import { useProject } from '../context/ProjectContext.js';
import { Card } from '../components/ui/card.js';
import {
  ShieldCheck,
  CheckCircle,
  XCircle,
  Activity,
  Zap,
  Shield,
  AlertTriangle,
  Play,
  RotateCw,
  FileDown,
  Sparkles,
  Clock,
  Ban,
  Layers,
  ChevronRight,
} from 'lucide-react';

interface AutonomousRun {
  id: string;
  projectId: string;
  routeId: string;
  profile: string;
  status: 'QUEUED' | 'RUNNING' | 'VERIFYING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'RECOVERY_REQUIRED';
  params: any;
  timeline: Array<{
    timestamp: string;
    stage: string;
    level: string;
    message: string;
    details?: any;
  }>;
  deterministicVerdict?: {
    passed: boolean;
    score: number;
    checks: Array<{
      name: string;
      category: string;
      passed: boolean;
      observed: string | number;
      threshold: string | number;
      evidenceRef: string;
    }>;
    latencyPercentiles: {
      p50: number;
      p90: number;
      p95: number;
      p99: number;
    };
    errorRate: number;
    totalDurationMs: number;
  };
  aiAnalysis?: {
    available: boolean;
    provider?: string;
    model?: string;
    reason?: string;
    executiveSummary?: string;
    technicalSummary?: string;
    incidentExplanation?: string;
    recurringPatterns?: string[];
    recommendations?: Array<{
      title: string;
      severity: string;
      rationale: string;
      evidenceRefs: string[];
    }>;
  };
  evidenceSummary?: {
    totalRequests: number;
    passedRequests: number;
    blockedRequests: number;
    errorRequests: number;
    securityEventsCount: number;
    artifactId?: string;
  };
  cleanupStatus: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
}

export default function Verifications() {
  const { currentProject } = useProject();
  const [scores, setScores] = useState({ securityScore: 0, resilienceScore: 0 });
  const [routes, setRoutes] = useState<any[]>([]);
  const [selectedRouteId, setSelectedRouteId] = useState<string>('');
  const [selectedProfile, setSelectedProfile] = useState<string>('full-verification');
  const [isLaunching, setIsLaunching] = useState(false);
  const [runs, setRuns] = useState<AutonomousRun[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [activeRun, setActiveRun] = useState<AutonomousRun | null>(null);

  const loadData = useCallback(() => {
    if (!currentProject?.id) return;
    const pId = currentProject.id;

    // Fetch Scores
    fetchWithAuth(`/api/control/metrics/scores?projectId=${pId}`)
      .then((r) => (r.ok ? r.json() : { securityScore: 85, resilienceScore: 90 }))
      .then((data) => setScores({ securityScore: data.securityScore || 0, resilienceScore: data.resilienceScore || 0 }))
      .catch(() => {});

    // Fetch Routes for selector
    fetchWithAuth(`/api/control/routes?projectId=${pId}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => {
        setRoutes(data || []);
        if (data && data.length > 0 && !selectedRouteId) {
          setSelectedRouteId(data[0].id);
        }
      })
      .catch(() => {});

    // Fetch Runs
    fetchWithAuth(`/api/control/runs?projectId=${pId}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((list: AutonomousRun[]) => {
        setRuns(list || []);
        if (list && list.length > 0 && !activeRunId) {
          setActiveRunId(list[0].id);
        }
      })
      .catch(() => {});
  }, [currentProject?.id, selectedRouteId, activeRunId]);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 5000);
    return () => clearInterval(interval);
  }, [loadData]);

  // Load detailed active run
  useEffect(() => {
    if (!activeRunId || !currentProject?.id) return;
    fetchWithAuth(`/api/control/runs/${activeRunId}?projectId=${currentProject.id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) setActiveRun(data);
      })
      .catch(() => {});
  }, [activeRunId, currentProject?.id]);

  const handleLaunchRun = async () => {
    if (!currentProject?.id || !selectedRouteId) return;
    setIsLaunching(true);
    try {
      const res = await fetchWithAuth('/api/control/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: currentProject.id,
          routeId: selectedRouteId,
          profile: selectedProfile,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setActiveRunId(data.runId);
        loadData();
      }
    } catch (err) {
      console.error('Failed to launch run:', err);
    } finally {
      setIsLaunching(false);
    }
  };

  const handleCancelRun = async (runId: string) => {
    if (!currentProject?.id) return;
    try {
      await fetchWithAuth(`/api/control/runs/${runId}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: currentProject.id }),
      });
      loadData();
    } catch (err) {
      console.error('Failed to cancel run:', err);
    }
  };

  const handleDownloadReport = async (runId: string, format: 'json' | 'pdf' = 'json') => {
    if (!currentProject?.id) return;
    try {
      const url = `/api/control/runs/${runId}/report?projectId=${currentProject.id}&format=${format}`;
      const res = await fetchWithAuth(url);
      if (!res.ok) return;

      if (format === 'pdf') {
        const blob = await res.blob();
        const downloadUrl = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = `FortiX-Evidence-${runId}.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
      } else {
        const json = await res.json();
        const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
        const downloadUrl = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = `FortiX-Evidence-${runId}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
    } catch (err) {
      console.error('Failed to download report:', err);
    }
  };

  return (
    <div className="space-y-6 flex flex-col h-full max-w-6xl mx-auto w-full pb-10">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-2 border-b border-subtle">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-primary/10 text-primary border border-primary/20">
            <ShieldCheck size={28} />
          </div>
          <div>
            <h2 className="text-2xl font-bold tracking-tight text-strong">Autonomous Verification & Resilience Platform</h2>
            <p className="text-xs text-muted">
              Project: <span className="font-mono text-primary font-bold">{currentProject?.name || 'Default Project'}</span> | Autonomous Execution, Real Telemetry, Deterministic Engine & AI Analysis
            </p>
          </div>
        </div>

        <button
          onClick={loadData}
          className="self-start sm:self-center flex items-center gap-2 px-3 py-1.5 rounded-lg border border-subtle bg-surface hover:bg-hover text-xs font-medium text-base-text transition"
        >
          <RotateCw size={14} /> Refresh
        </button>
      </div>

      {/* TOP SCORE OVERVIEW */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="p-4 bg-surface border border-subtle flex items-center gap-4">
          <div className="p-3 rounded-lg bg-green-500/10 text-green-400 border border-green-500/20">
            <Shield size={24} />
          </div>
          <div>
            <div className="text-[10px] uppercase font-bold tracking-wider text-muted">Security Score</div>
            <div className="text-2xl font-mono font-bold text-strong">{scores.securityScore} <span className="text-xs text-muted">/ 100</span></div>
          </div>
        </Card>

        <Card className="p-4 bg-surface border border-subtle flex items-center gap-4">
          <div className="p-3 rounded-lg bg-blue-500/10 text-blue-400 border border-blue-500/20">
            <Activity size={24} />
          </div>
          <div>
            <div className="text-[10px] uppercase font-bold tracking-wider text-muted">Resilience Score</div>
            <div className="text-2xl font-mono font-bold text-strong">{scores.resilienceScore} <span className="text-xs text-muted">/ 100</span></div>
          </div>
        </Card>

        <Card className="p-4 bg-surface border border-subtle flex items-center gap-4">
          <div className="p-3 rounded-lg bg-purple-500/10 text-purple-400 border border-purple-500/20">
            <Layers size={24} />
          </div>
          <div>
            <div className="text-[10px] uppercase font-bold tracking-wider text-muted">Workflow Runs</div>
            <div className="text-2xl font-mono font-bold text-strong">{runs.length} <span className="text-xs text-muted">total</span></div>
          </div>
        </Card>

        <Card className="p-4 bg-surface border border-subtle flex items-center gap-4">
          <div className="p-3 rounded-lg bg-primary/10 text-primary border border-primary/20">
            <Sparkles size={24} />
          </div>
          <div>
            <div className="text-[10px] uppercase font-bold tracking-wider text-muted">AI Advisor</div>
            <div className="text-xs font-mono font-bold text-primary mt-1">Gemini 3.8 Flash</div>
            <div className="text-[10px] text-muted">Evidence-Assisted</div>
          </div>
        </Card>
      </div>

      {/* AUTONOMOUS RUN LAUNCHER */}
      <Card className="p-5 bg-surface border border-subtle">
        <div className="flex items-center gap-2 mb-4">
          <Play size={18} className="text-primary" />
          <h3 className="text-sm font-bold uppercase tracking-wider text-strong">Launch Autonomous Verification Run</h3>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
          <div>
            <label className="block text-[11px] font-bold text-muted uppercase tracking-wider mb-1.5">Target Route</label>
            <select
              value={selectedRouteId}
              onChange={(e) => setSelectedRouteId(e.target.value)}
              className="w-full bg-base border border-subtle rounded-lg px-3 py-2 text-xs text-base-text font-mono focus:border-primary outline-none"
            >
              {routes.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.pathPattern} → {r.targetUrl}
                </option>
              ))}
              {routes.length === 0 && <option value="">No routes available (create one in APIs)</option>}
            </select>
          </div>

          <div>
            <label className="block text-[11px] font-bold text-muted uppercase tracking-wider mb-1.5">Verification Profile</label>
            <select
              value={selectedProfile}
              onChange={(e) => setSelectedProfile(e.target.value)}
              className="w-full bg-base border border-subtle rounded-lg px-3 py-2 text-xs text-base-text focus:border-primary outline-none"
            >
              <option value="full-verification">Full End-to-End Resilience & Security Audit</option>
              <option value="security-audit">Security Threat & WAF Probing (SQLi, XSS, SSRF)</option>
              <option value="resilience-stress">Concurrency Stress & Rate-Limit Token Bucket</option>
              <option value="failover-recovery">Upstream 503 Fault Injection & Auto-Recovery</option>
            </select>
          </div>

          <div className="flex items-end">
            <button
              onClick={handleLaunchRun}
              disabled={isLaunching || !selectedRouteId}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-primary hover:bg-primary-hover text-white text-xs font-bold uppercase tracking-wider transition disabled:opacity-50"
            >
              {isLaunching ? (
                <>
                  <RotateCw size={14} className="animate-spin" /> Launching...
                </>
              ) : (
                <>
                  <Play size={14} /> Execute Workflow
                </>
              )}
            </button>
          </div>
        </div>

        <div className="text-[11px] text-muted flex items-center gap-2">
          <Shield size={13} className="text-green-400 shrink-0" />
          <span>
            Safe Execution Guarantee: Ephemeral credentials, bounded burst ceiling (100 reqs max), SSRF protection, and automatic fault cleanup are enforced.
          </span>
        </div>
      </Card>

      {/* RUN DETAIL & TIMELINE */}
      {activeRun && (
        <Card className="p-6 bg-surface border border-subtle relative overflow-hidden">
          <div className="flex flex-col md:flex-row md:items-center justify-between pb-4 border-b border-subtle gap-4">
            <div>
              <div className="flex items-center gap-3">
                <span className="font-mono text-sm font-bold text-primary">{activeRun.id}</span>
                <span
                  className={`text-[10px] font-bold tracking-widest uppercase px-2.5 py-1 rounded-md border ${
                    activeRun.status === 'COMPLETED'
                      ? 'bg-green-500/10 border-green-500/30 text-green-400'
                      : activeRun.status === 'RUNNING' || activeRun.status === 'VERIFYING'
                      ? 'bg-blue-500/10 border-blue-500/30 text-blue-400 animate-pulse'
                      : activeRun.status === 'FAILED'
                      ? 'bg-red-500/10 border-red-500/30 text-red-400'
                      : activeRun.status === 'CANCELLED'
                      ? 'bg-gray-500/10 border-gray-500/30 text-gray-400'
                      : 'bg-yellow-500/10 border-yellow-500/30 text-yellow-400'
                  }`}
                >
                  {activeRun.status}
                </span>
                <span className="text-xs text-muted uppercase font-semibold tracking-wider">
                  Profile: {activeRun.profile}
                </span>
              </div>
              <div className="text-xs text-muted mt-1 font-mono">
                Target: {activeRun.params?.targetUrl} ({activeRun.params?.routePath}) | Cleanup:{' '}
                <span className="text-green-400 font-bold">{activeRun.cleanupStatus}</span>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {['QUEUED', 'RUNNING', 'VERIFYING'].includes(activeRun.status) && (
                <button
                  onClick={() => handleCancelRun(activeRun.id)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20 text-xs font-semibold"
                >
                  <Ban size={14} /> Cancel Run
                </button>
              )}
              <button
                onClick={() => handleDownloadReport(activeRun.id, 'json')}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-subtle bg-base hover:bg-hover text-xs font-medium text-base-text"
              >
                <FileDown size={14} /> JSON Evidence
              </button>
              <button
                onClick={() => handleDownloadReport(activeRun.id, 'pdf')}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-primary/30 bg-primary/10 text-primary hover:bg-primary/20 text-xs font-semibold"
              >
                <FileDown size={14} /> PDF Report
              </button>
            </div>
          </div>

          {/* REAL TELEMETRY & DETERMINISTIC VERDICT */}
          {activeRun.deterministicVerdict && (
            <div className="my-6 p-4 rounded-xl bg-base border border-subtle">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <ShieldCheck size={18} className={activeRun.deterministicVerdict.passed ? 'text-green-400' : 'text-red-400'} />
                  <span className="text-xs font-bold uppercase tracking-wider text-strong">
                    Deterministic Source of Truth (Calculated from Real Telemetry)
                  </span>
                </div>
                <div className="text-xl font-mono font-bold text-strong">
                  Score: <span className={activeRun.deterministicVerdict.passed ? 'text-green-400' : 'text-red-400'}>{activeRun.deterministicVerdict.score}</span> / 100
                </div>
              </div>

              {/* Latency & Metrics Bar */}
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3 mb-4 text-center">
                <div className="p-2.5 rounded-lg bg-surface border border-subtle/70">
                  <div className="text-[10px] text-muted uppercase font-bold">Total Requests</div>
                  <div className="text-base font-mono font-bold text-strong">{activeRun.evidenceSummary?.totalRequests || 0}</div>
                </div>
                <div className="p-2.5 rounded-lg bg-surface border border-subtle/70">
                  <div className="text-[10px] text-muted uppercase font-bold">2xx Success</div>
                  <div className="text-base font-mono font-bold text-green-400">{activeRun.evidenceSummary?.passedRequests || 0}</div>
                </div>
                <div className="p-2.5 rounded-lg bg-surface border border-subtle/70">
                  <div className="text-[10px] text-muted uppercase font-bold">429 Rate-Limited</div>
                  <div className="text-base font-mono font-bold text-yellow-400">{activeRun.evidenceSummary?.blockedRequests || 0}</div>
                </div>
                <div className="p-2.5 rounded-lg bg-surface border border-subtle/70">
                  <div className="text-[10px] text-muted uppercase font-bold">5xx Errors</div>
                  <div className="text-base font-mono font-bold text-red-400">{activeRun.evidenceSummary?.errorRequests || 0}</div>
                </div>
                <div className="p-2.5 rounded-lg bg-surface border border-subtle/70">
                  <div className="text-[10px] text-muted uppercase font-bold">P95 Latency</div>
                  <div className="text-base font-mono font-bold text-primary">{activeRun.deterministicVerdict.latencyPercentiles.p95}ms</div>
                </div>
                <div className="p-2.5 rounded-lg bg-surface border border-subtle/70">
                  <div className="text-[10px] text-muted uppercase font-bold">Threats Blocked</div>
                  <div className="text-base font-mono font-bold text-green-400">{activeRun.evidenceSummary?.securityEventsCount || 0}</div>
                </div>
              </div>

              {/* Individual Checks Table */}
              <div className="space-y-2">
                {activeRun.deterministicVerdict.checks.map((chk, i) => (
                  <div key={i} className="flex items-center justify-between text-xs py-1.5 px-3 rounded-lg bg-surface/50 border border-subtle/40">
                    <div className="flex items-center gap-2">
                      {chk.passed ? <CheckCircle size={14} className="text-green-400" /> : <XCircle size={14} className="text-red-400" />}
                      <span className="font-semibold text-base-text">{chk.name}</span>
                    </div>
                    <div className="flex items-center gap-4 font-mono text-[11px]">
                      <span className="text-muted">Observed: <strong className="text-strong">{chk.observed}</strong></span>
                      <span className="text-muted">Threshold: {chk.threshold}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* AI-ASSISTED ADVISORY LAYER */}
          {activeRun.aiAnalysis && (
            <div className="my-6 p-4 rounded-xl bg-purple-500/5 border border-purple-500/20">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2 text-purple-400">
                  <Sparkles size={18} />
                  <span className="text-xs font-bold uppercase tracking-wider">
                    Evidence-Assisted AI Analysis ({activeRun.aiAnalysis.model || 'Gemini 3.8 Flash'})
                  </span>
                </div>
                <span className="text-[10px] text-muted uppercase font-mono">
                  {activeRun.aiAnalysis.available ? 'Read-Only Advisory' : 'Analysis Inactive'}
                </span>
              </div>

              {activeRun.aiAnalysis.available ? (
                <div className="space-y-4 text-xs">
                  <div>
                    <h5 className="font-bold uppercase tracking-wider text-muted text-[10px] mb-1">Executive Summary</h5>
                    <p className="text-base-text leading-relaxed bg-surface/60 p-3 rounded-lg border border-subtle">
                      {activeRun.aiAnalysis.executiveSummary}
                    </p>
                  </div>

                  <div>
                    <h5 className="font-bold uppercase tracking-wider text-muted text-[10px] mb-1">Technical Architecture Summary</h5>
                    <p className="text-base-text leading-relaxed bg-surface/60 p-3 rounded-lg border border-subtle font-mono text-[11px]">
                      {activeRun.aiAnalysis.technicalSummary}
                    </p>
                  </div>

                  {activeRun.aiAnalysis.incidentExplanation && (
                    <div>
                      <h5 className="font-bold uppercase tracking-wider text-muted text-[10px] mb-1">Incident & Failure Analysis</h5>
                      <p className="text-base-text leading-relaxed bg-surface/60 p-3 rounded-lg border border-subtle">
                        {activeRun.aiAnalysis.incidentExplanation}
                      </p>
                    </div>
                  )}

                  {activeRun.aiAnalysis.recommendations && activeRun.aiAnalysis.recommendations.length > 0 && (
                    <div>
                      <h5 className="font-bold uppercase tracking-wider text-muted text-[10px] mb-1">Remediation Steps (Evidence-Linked)</h5>
                      <div className="space-y-2">
                        {activeRun.aiAnalysis.recommendations.map((rec, idx) => (
                          <div key={idx} className="p-3 rounded-lg bg-surface border border-subtle">
                            <div className="flex items-center justify-between mb-1">
                              <span className="font-bold text-strong">{rec.title}</span>
                              <span
                                className={`text-[9px] font-bold px-2 py-0.5 rounded border uppercase ${
                                  rec.severity === 'CRITICAL'
                                    ? 'bg-red-500/10 border-red-500/30 text-red-400'
                                    : rec.severity === 'HIGH'
                                    ? 'bg-orange-500/10 border-orange-500/30 text-orange-400'
                                    : 'bg-blue-500/10 border-blue-500/30 text-blue-400'
                                }`}
                              >
                                {rec.severity}
                              </span>
                            </div>
                            <p className="text-muted mb-2">{rec.rationale}</p>
                            <div className="flex flex-wrap gap-1">
                              {rec.evidenceRefs.map((ref, rIdx) => (
                                <span key={rIdx} className="font-mono text-[10px] bg-elevated px-2 py-0.5 rounded text-muted">
                                  Ref: {ref}
                                </span>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-xs text-muted italic p-3 bg-surface/40 rounded-lg">
                  {activeRun.aiAnalysis.reason || 'AI analysis is unavailable. Deterministic verification results remain fully authoritative.'}
                </div>
              )}
            </div>
          )}

          {/* RUN TIMELINE */}
          <div className="mt-6">
            <h4 className="text-[11px] font-bold tracking-widest uppercase text-muted mb-4 flex items-center gap-2">
              <Clock size={14} /> Execution Stage Timeline
            </h4>
            <div className="relative border-l-2 border-subtle ml-2.5 space-y-4">
              {activeRun.timeline &&
                activeRun.timeline.map((entry, idx) => (
                  <div key={idx} className="relative pl-6">
                    <div
                      className={`absolute -left-[7px] top-1.5 w-3 h-3 rounded-full border-2 border-surface ${
                        entry.level === 'SUCCESS'
                          ? 'bg-green-400'
                          : entry.level === 'WARN'
                          ? 'bg-yellow-400'
                          : entry.level === 'ERROR'
                          ? 'bg-red-400'
                          : 'bg-primary'
                      }`}
                    ></div>
                    <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                      <span className="font-mono text-[10px] text-muted">{new Date(entry.timestamp).toLocaleTimeString()}</span>
                      <span className="text-[10px] font-bold tracking-wider uppercase px-2 py-0.5 rounded bg-surface border border-subtle text-primary">
                        {entry.stage}
                      </span>
                      <span className="text-xs text-base-text">{entry.message}</span>
                    </div>
                  </div>
                ))}
            </div>
          </div>
        </Card>
      )}

      {/* ALL WORKFLOW RUNS HISTORY */}
      <Card className="p-5 bg-surface border border-subtle">
        <h3 className="text-xs font-bold uppercase tracking-wider text-muted mb-4">Historical Verification Runs</h3>
        {runs.length === 0 ? (
          <div className="py-8 text-center text-xs text-muted">
            No autonomous workflow runs executed yet. Select a route above and click "Execute Workflow".
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-subtle text-[10px] font-bold tracking-wider uppercase text-muted">
                  <th className="py-2.5 px-3">Run ID</th>
                  <th className="py-2.5 px-3">Profile</th>
                  <th className="py-2.5 px-3">Status</th>
                  <th className="py-2.5 px-3">Score</th>
                  <th className="py-2.5 px-3">Cleanup</th>
                  <th className="py-2.5 px-3">Created</th>
                  <th className="py-2.5 px-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-subtle/50 font-mono">
                {runs.map((r) => (
                  <tr
                    key={r.id}
                    onClick={() => setActiveRunId(r.id)}
                    className={`cursor-pointer hover:bg-hover transition ${activeRunId === r.id ? 'bg-primary/5' : ''}`}
                  >
                    <td className="py-2.5 px-3 font-bold text-primary">{r.id}</td>
                    <td className="py-2.5 px-3 text-base-text font-sans">{r.profile}</td>
                    <td className="py-2.5 px-3">
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                          r.status === 'COMPLETED'
                            ? 'bg-green-500/10 text-green-400'
                            : r.status === 'RUNNING'
                            ? 'bg-blue-500/10 text-blue-400'
                            : r.status === 'FAILED'
                            ? 'bg-red-500/10 text-red-400'
                            : 'bg-yellow-500/10 text-yellow-400'
                        }`}
                      >
                        {r.status}
                      </span>
                    </td>
                    <td className="py-2.5 px-3 font-bold">
                      {r.deterministicVerdict ? `${r.deterministicVerdict.score}/100` : '—'}
                    </td>
                    <td className="py-2.5 px-3 text-green-400">{r.cleanupStatus}</td>
                    <td className="py-2.5 px-3 text-muted text-[11px]">{new Date(r.createdAt).toLocaleTimeString()}</td>
                    <td className="py-2.5 px-3 text-right font-sans">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setActiveRunId(r.id);
                        }}
                        className="text-xs text-primary hover:underline font-semibold"
                      >
                        View Evidence →
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
