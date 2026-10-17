import { fetchWithAuth } from "../lib/api.js";
import React, { useEffect, useState } from 'react';
import { Card } from '../components/ui/card.js';
import { Play, XCircle, CheckCircle, Clock, ShieldAlert, Target, ShieldCheck, Zap, RotateCcw, Trash2, AlertTriangle, Layers, Activity, RefreshCw } from 'lucide-react';
import { useProject } from '../context/ProjectContext.js';

export default function Experiments() {
  const { currentProject } = useProject();
  const [activeTab, setActiveTab] = useState<'lifecycle' | 'dlq'>('lifecycle');
  const [experiments, setExperiments] = useState<any[]>([]);
  const [routes, setRoutes] = useState<any[]>([]);
  const [selectedRouteId, setSelectedRouteId] = useState('');
  const [selectedType, setSelectedType] = useState('latency');
  const [scheduledTime, setScheduledTime] = useState('');
  const [hypothesis, setHypothesis] = useState('The API should degrade gracefully and reject upstream traffic if latency exceeds 500ms, returning a 503 instead of hanging.');
  const [toast, setToast] = useState<{ message: string, type: 'success' | 'error' } | null>(null);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [isAuthorized, setIsAuthorized] = useState(false);

  // DLQ State
  const [dlqJobs, setDlqJobs] = useState<any[]>([]);
  const [dlqStats, setDlqStats] = useState<any>(null);
  const [expandedDlqJob, setExpandedDlqJob] = useState<string | null>(null);
  const [isDlqLoading, setIsDlqLoading] = useState(false);

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3500);
  };

  useEffect(() => {
    fetchWithAuth('/api/control/routes').then(r => r.ok ? r.json() : []).then(data => {
      setRoutes(data);
      if (data.length > 0) setSelectedRouteId(data[0].id);
    }).catch(() => {});
  }, [currentProject?.id]);

  const fetchDlqData = async () => {
    setIsDlqLoading(true);
    try {
      const [jobsRes, statsRes] = await Promise.all([
        fetchWithAuth('/api/control/dlq'),
        fetchWithAuth('/api/control/dlq/stats')
      ]);
      if (jobsRes.ok) {
        const jobsData = await jobsRes.json();
        setDlqJobs(jobsData.jobs || []);
      }
      if (statsRes.ok) {
        const statsData = await statsRes.json();
        setDlqStats(statsData);
      }
    } catch (err) {
      console.error('Failed to load DLQ data', err);
    } finally {
      setIsDlqLoading(false);
    }
  };

  useEffect(() => {
    const poll = async () => {
      try {
        const r = await fetchWithAuth('/api/control/experiments');
        if (r.ok) {
          const data = await r.json();
          setExperiments(data);
        }
      } catch (err) {}
    };
    poll();
    fetchDlqData();
    const interval = setInterval(() => {
      poll();
      fetchDlqData();
    }, 4000);
    return () => clearInterval(interval);
  }, [currentProject?.id]);

  const triggerExperiment = async () => {
    if (!isAuthorized) return;
    try {
      const res = await fetchWithAuth('/api/control/experiments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: localStorage.getItem('fortix_project_id') || '',
          routeId: selectedRouteId,
          type: selectedType,
          config: { latencyMs: 800, durationMs: 15000 },
          scheduledTime: scheduledTime ? new Date(scheduledTime).toISOString() : null
        })
      });
      if (res.ok) {
        showToast(`Launched ${selectedType.toUpperCase()} experiment.`);
        setIsAuthorized(false);
      }
    } catch (err) {
      showToast('Failed to trigger experiment', 'error');
    }
  };

  const handleRetryJob = async (jobId: string) => {
    try {
      const res = await fetchWithAuth(`/api/control/dlq/${jobId}/retry`, { method: 'POST' });
      if (res.ok) {
        showToast(`Re-enqueued DLQ job ${jobId.slice(0, 8)}...`);
        fetchDlqData();
      } else {
        showToast('Failed to retry job', 'error');
      }
    } catch (e) {
      showToast('Network error retrying job', 'error');
    }
  };

  const handleDiscardJob = async (jobId: string) => {
    try {
      const res = await fetchWithAuth(`/api/control/dlq/${jobId}`, { method: 'DELETE' });
      if (res.ok) {
        showToast(`Discarded job ${jobId.slice(0, 8)}... from DLQ`);
        fetchDlqData();
      } else {
        showToast('Failed to discard job', 'error');
      }
    } catch (e) {
      showToast('Network error discarding job', 'error');
    }
  };

  const handleRetryAll = async () => {
    try {
      const res = await fetchWithAuth('/api/control/dlq/retry-all', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        showToast(`Re-enqueued ${data.retriedCount} DLQ jobs for execution.`);
        fetchDlqData();
      }
    } catch (e) {
      showToast('Failed to retry all DLQ jobs', 'error');
    }
  };

  const handlePurgeAll = async () => {
    if (!confirm('Are you sure you want to permanently purge all Dead-Letter Queue records?')) return;
    try {
      const res = await fetchWithAuth('/api/control/dlq/purge-all', { method: 'DELETE' });
      if (res.ok) {
        const data = await res.json();
        showToast(`Purged ${data.purgedCount} DLQ jobs.`);
        fetchDlqData();
      }
    } catch (e) {
      showToast('Failed to purge DLQ', 'error');
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'COMPLETED': return 'text-green-500 bg-green-500/10 border-green-500/30';
      case 'FAILED': return 'text-red-500 bg-red-500/10 border-red-500/30';
      case 'RUNNING': return 'text-blue-500 bg-blue-500/10 border-blue-500/30 animate-pulse';
      case 'QUEUED': return 'text-yellow-500 bg-yellow-500/10 border-yellow-500/30';
      default: return 'text-muted border-subtle';
    }
  };

  return (
    <div className="space-y-6 flex flex-col h-full max-w-5xl mx-auto w-full">
      <div className="flex justify-between items-center mb-2">
        <div>
          <h2 className="text-3xl font-bold tracking-tight text-strong">Experiment Engine & Worker Resilience</h2>
          <p className="text-xs text-muted">Chaos fault injection, BullMQ queue durability, and Dead-Letter Queue (DLQ) automated recovery.</p>
        </div>
      </div>

      {toast && (
        <div className={`px-4 py-3 rounded-xl border flex items-center gap-2 text-sm font-bold shadow-glass ${toast.type === 'success' ? 'bg-green-500/10 border-green-500/30 text-green-400' : 'bg-red-500/10 border-red-500/30 text-red-400'}`}>
          {toast.type === 'success' ? <CheckCircle size={16} /> : <XCircle size={16} />}
          {toast.message}
        </div>
      )}

      {/* Control Panel */}
      <Card className="p-6 bg-surface border border-subtle shadow-glass flex flex-col md:flex-row gap-8">
        <div className="flex-1 space-y-4">
          <div className="flex items-center gap-2 text-primary font-bold tracking-widest uppercase text-xs mb-4">
            <Zap size={14} /> Configure Experiment
          </div>
          
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-[10px] font-bold uppercase tracking-widest text-muted block mb-2">Target Route</label>
              <select value={selectedRouteId} onChange={e => setSelectedRouteId(e.target.value)} className="w-full bg-base border border-subtle text-strong text-sm rounded-xl px-3 py-2 outline-none focus:border-primary">
                {routes.map(r => <option key={r.id} value={r.id}>{r.pathPattern || r.path || r.id}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[10px] font-bold uppercase tracking-widest text-muted block mb-2">Fault Type</label>
              <select value={selectedType} onChange={e => setSelectedType(e.target.value)} className="w-full bg-base border border-subtle text-strong text-sm rounded-xl px-3 py-2 outline-none focus:border-primary">
                <option value="latency">Latency Injection (800ms)</option>
                <option value="error_5xx">HTTP 503 Failure</option>
                <option value="timeout">Gateway Timeout Simulation</option>
                <option value="traffic_burst">Traffic Burst (100 req/s)</option>
              </select>
            </div>
          </div>
          
          <div>
            <label className="text-[10px] font-bold uppercase tracking-widest text-muted block mb-2">Hypothesis (Verification Objective)</label>
            <textarea 
              value={hypothesis} 
              onChange={e => setHypothesis(e.target.value)}
              className="w-full h-20 bg-base border border-subtle text-strong text-sm rounded-xl px-3 py-2 outline-none focus:border-primary resize-none"
            />
          </div>
        </div>

        <div className="w-full md:w-72 space-y-3 border-t md:border-t-0 md:border-l border-subtle pt-6 md:pt-0 md:pl-6 flex flex-col justify-end">
          <div className="text-[10px] font-bold tracking-widest uppercase text-muted mb-1">Experiment Safety Controls</div>
          <div className="bg-card p-3 rounded-xl border border-subtle space-y-2 text-xs">
            <div className="flex justify-between text-muted"><span className="uppercase text-[10px] tracking-widest">Target</span><span className="font-mono text-strong">{selectedRouteId ? selectedRouteId.slice(0, 10) + '...' : '/api/*'}</span></div>
            <div className="flex justify-between text-muted"><span className="uppercase text-[10px] tracking-widest">Intensity</span><span className="font-mono text-strong">800 ms</span></div>
            <div className="flex justify-between text-muted"><span className="uppercase text-[10px] tracking-widest">Duration</span><span className="font-mono text-strong">15 seconds</span></div>
            <div className="flex justify-between text-muted"><span className="uppercase text-[10px] tracking-widest">Retries</span><span className="font-mono text-strong">3x Backoff</span></div>
            <div className="flex justify-between text-muted border-t border-subtle/50 pt-2"><span className="uppercase text-[10px] tracking-widest">DLQ Recovery</span><span className="font-mono text-green-500 font-bold flex items-center gap-1"><CheckCircle size={10}/> BullMQ DLQ</span></div>
          </div>
          
          <label className="flex items-center gap-2 text-xs text-base-text cursor-pointer my-2">
            <input type="checkbox" checked={isAuthorized} onChange={e => setIsAuthorized(e.target.checked)} className="rounded bg-base border-subtle" />
            I authorize this fault injection test.
          </label>
          
          <button 
            onClick={triggerExperiment} 
            disabled={!isAuthorized}
            className={`w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-xs font-bold tracking-widest uppercase transition ${isAuthorized ? 'bg-primary text-inverted hover:bg-primary-hover shadow-glass cursor-pointer' : 'bg-base border border-subtle text-muted cursor-not-allowed'}`}
          >
            <Play size={16} /> {isAuthorized ? 'Execute Chaos' : 'Safety Locked'}
          </button>
        </div>
      </Card>

      {/* Navigation Tabs & DLQ Overview */}
      <div className="flex-1 bg-surface border border-subtle rounded-2xl flex flex-col overflow-hidden shadow-glass min-h-[350px]">
        <div className="px-6 py-4 border-b border-subtle bg-card flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setActiveTab('lifecycle')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold tracking-widest uppercase transition flex items-center gap-1.5 ${activeTab === 'lifecycle' ? 'bg-primary text-inverted shadow-sm' : 'text-muted hover:text-strong'}`}
            >
              <Clock size={14} /> Execution Lifecycle ({experiments.length})
            </button>
            <button
              onClick={() => setActiveTab('dlq')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold tracking-widest uppercase transition flex items-center gap-1.5 ${activeTab === 'dlq' ? 'bg-red-500/20 text-red-400 border border-red-500/30' : 'text-muted hover:text-strong'}`}
            >
              <AlertTriangle size={14} /> Dead-Letter Queue ({dlqJobs.length})
            </button>
          </div>

          {activeTab === 'dlq' && (
            <div className="flex items-center gap-2">
              <button
                onClick={fetchDlqData}
                disabled={isDlqLoading}
                className="p-1.5 bg-surface hover:bg-hover border border-subtle rounded-lg text-muted hover:text-strong text-xs transition"
                title="Refresh DLQ"
              >
                <RefreshCw size={13} className={isDlqLoading ? 'animate-spin' : ''} />
              </button>
              <button
                onClick={handleRetryAll}
                disabled={dlqJobs.length === 0}
                className="px-2.5 py-1.5 bg-blue-500/10 border border-blue-500/30 text-blue-400 hover:bg-blue-500/20 rounded-lg text-[10px] font-bold tracking-widest uppercase transition disabled:opacity-40 flex items-center gap-1"
              >
                <RotateCcw size={12} /> Retry All
              </button>
              <button
                onClick={handlePurgeAll}
                disabled={dlqJobs.length === 0}
                className="px-2.5 py-1.5 bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20 rounded-lg text-[10px] font-bold tracking-widest uppercase transition disabled:opacity-40 flex items-center gap-1"
              >
                <Trash2 size={12} /> Purge DLQ
              </button>
            </div>
          )}
        </div>

        {/* Tab 1: Execution Lifecycle */}
        {activeTab === 'lifecycle' && (
          <div className="flex-1 overflow-auto">
            <table className="w-full text-left text-sm text-muted">
              <thead className="bg-elevated border-b border-subtle text-[10px] uppercase font-bold tracking-widest">
                <tr>
                  <th className="px-6 py-4">Timestamp</th>
                  <th className="px-6 py-4">Target</th>
                  <th className="px-6 py-4">Fault Profile</th>
                  <th className="px-6 py-4">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-subtle">
                {experiments.length === 0 ? (
                  <tr><td colSpan={4} className="px-6 py-8 text-center text-muted">No experiments launched in this project.</td></tr>
                ) : experiments.map(e => (
                  <React.Fragment key={e.id}>
                    <tr 
                      className={`hover:bg-hover transition cursor-pointer ${expandedRow === e.id ? 'bg-hover' : ''}`}
                      onClick={() => setExpandedRow(expandedRow === e.id ? null : e.id)}
                    >
                      <td className="px-6 py-4 font-mono text-xs">{new Date(e.createdAt).toLocaleTimeString()}</td>
                      <td className="px-6 py-4 font-mono text-base-text">{e.routeId ? e.routeId.slice(0, 16) + '...' : '/api/*'}</td>
                      <td className="px-6 py-4 font-bold text-strong uppercase">{e.type}</td>
                      <td className="px-6 py-4">
                        <span className={`px-2 py-1 rounded text-[10px] font-bold border tracking-widest ${getStatusColor(e.status)}`}>
                          {e.status}
                        </span>
                      </td>
                    </tr>
                    {expandedRow === e.id && (
                      <tr className="bg-elevated border-b-2 border-primary/20">
                        <td colSpan={4} className="px-8 py-6">
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                            <div className="space-y-4">
                              <div>
                                <div className="text-[10px] font-bold tracking-widest uppercase text-muted mb-2">Scientific Hypothesis</div>
                                <p className="text-sm text-base-text italic bg-card p-4 rounded border border-subtle">
                                  "The API should degrade gracefully and reject upstream traffic if latency exceeds 500ms, returning a 503 instead of hanging."
                                </p>
                              </div>
                              
                              <div>
                                <div className="text-[10px] font-bold tracking-widest uppercase text-muted mb-2">Blast Radius</div>
                                <div className="grid grid-cols-2 gap-4">
                                  <div className="bg-card p-3 rounded border border-subtle">
                                    <div className="text-[10px] font-bold tracking-widest uppercase text-muted mb-1">Impacted Requests</div>
                                    <div className="font-mono text-xl text-strong">126</div>
                                  </div>
                                  <div className="bg-card p-3 rounded border border-subtle">
                                    <div className="text-[10px] font-bold tracking-widest uppercase text-muted mb-1">Traffic Share</div>
                                    <div className="font-mono text-xl text-strong">24<span className="text-sm text-muted">%</span></div>
                                  </div>
                                </div>
                              </div>
                            </div>
                            
                            <div className="space-y-4">
                              <div className="text-[10px] font-bold tracking-widest uppercase text-muted mb-2">Execution Timeline</div>
                              <div className="relative border-l-2 border-subtle ml-2 space-y-4 text-xs font-mono">
                                <div className="relative pl-4"><div className="absolute -left-[5px] top-1 w-2 h-2 rounded-full bg-subtle"></div><span className="text-muted mr-4">T+0s</span> CREATED</div>
                                <div className="relative pl-4"><div className="absolute -left-[5px] top-1 w-2 h-2 rounded-full bg-blue-500"></div><span className="text-muted mr-4">T+1s</span> QUEUED / RUNNING</div>
                                <div className="relative pl-4"><div className="absolute -left-[5px] top-1 w-2 h-2 rounded-full bg-primary animate-pulse"></div><span className="text-muted mr-4">T+2s</span> FAULT_INJECTED</div>
                                {e.status === 'COMPLETED' && (
                                  <>
                                    <div className="relative pl-4"><div className="absolute -left-[5px] top-1 w-2 h-2 rounded-full bg-subtle"></div><span className="text-muted mr-4">T+17s</span> FAULT_REMOVED</div>
                                    <div className="relative pl-4"><div className="absolute -left-[5px] top-1 w-2 h-2 rounded-full bg-green-500"></div><span className="text-muted mr-4">T+20s</span> COMPLETED</div>
                                  </>
                                )}
                                {e.status === 'FAILED' && (
                                  <div className="relative pl-4"><div className="absolute -left-[5px] top-1 w-2 h-2 rounded-full bg-red-500"></div><span className="text-red-400 mr-4">T+Failed</span> ROUTED TO DLQ</div>
                                )}
                              </div>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Tab 2: Dead-Letter Queue Inspection */}
        {activeTab === 'dlq' && (
          <div className="flex-1 flex flex-col">
            {/* Queue Stats Bar */}
            {dlqStats && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 p-4 bg-elevated border-b border-subtle text-xs">
                <div className="bg-card p-3 rounded-xl border border-subtle">
                  <div className="text-muted text-[10px] uppercase font-bold tracking-widest">DLQ Failures</div>
                  <div className="text-xl font-bold font-mono text-red-400">{dlqStats.dlqTotal || 0}</div>
                </div>
                {dlqStats.queues?.map((q: any) => (
                  <div key={q.queueName} className="bg-card p-3 rounded-xl border border-subtle">
                    <div className="text-muted text-[10px] uppercase font-bold tracking-widest">{q.queueName} Queue</div>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-xs font-mono text-strong">Act: <b className="text-blue-400">{q.active}</b></span>
                      <span className="text-xs font-mono text-strong">Wait: <b className="text-yellow-400">{q.waiting}</b></span>
                      <span className="text-xs font-mono text-strong">Done: <b className="text-green-400">{q.completed}</b></span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="flex-1 overflow-auto">
              <table className="w-full text-left text-sm text-muted">
                <thead className="bg-elevated border-b border-subtle text-[10px] uppercase font-bold tracking-widest">
                  <tr>
                    <th className="px-6 py-4">Job ID / Queue</th>
                    <th className="px-6 py-4">Job Name</th>
                    <th className="px-6 py-4">Attempts</th>
                    <th className="px-6 py-4">Failed Reason</th>
                    <th className="px-6 py-4">Failed At</th>
                    <th className="px-6 py-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-subtle">
                  {dlqJobs.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-6 py-12 text-center text-muted">
                        <CheckCircle size={28} className="mx-auto text-green-500 mb-2 opacity-80" />
                        <div className="font-bold text-strong text-sm">Dead-Letter Queue is Empty</div>
                        <p className="text-xs text-muted mt-1">All background BullMQ worker jobs are executing and completing cleanly.</p>
                      </td>
                    </tr>
                  ) : dlqJobs.map(job => (
                    <React.Fragment key={job.id}>
                      <tr 
                        className={`hover:bg-hover transition cursor-pointer ${expandedDlqJob === job.id ? 'bg-hover' : ''}`}
                        onClick={() => setExpandedDlqJob(expandedDlqJob === job.id ? null : job.id)}
                      >
                        <td className="px-6 py-4">
                          <div className="font-mono text-xs text-strong">{job.id.slice(0, 12)}...</div>
                          <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-surface border border-subtle text-muted">
                            {job.queueName}
                          </span>
                        </td>
                        <td className="px-6 py-4 font-mono text-xs text-base-text">{job.jobName}</td>
                        <td className="px-6 py-4">
                          <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-red-500/10 border border-red-500/30 text-red-400 font-mono">
                            {job.attemptsMade} / {job.maxAttempts} Max
                          </span>
                        </td>
                        <td className="px-6 py-4 text-xs font-mono text-red-400 max-w-xs truncate" title={job.failedReason}>
                          {job.failedReason}
                        </td>
                        <td className="px-6 py-4 font-mono text-xs text-muted">
                          {new Date(job.failedAt).toLocaleTimeString()}
                        </td>
                        <td className="px-6 py-4 text-right space-x-2" onClick={e => e.stopPropagation()}>
                          <button
                            onClick={() => handleRetryJob(job.id)}
                            title="Replay / Retry Job"
                            className="p-1.5 bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 border border-blue-500/30 rounded-lg text-xs transition"
                          >
                            <RotateCcw size={13} />
                          </button>
                          <button
                            onClick={() => handleDiscardJob(job.id)}
                            title="Discard from DLQ"
                            className="p-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30 rounded-lg text-xs transition"
                          >
                            <Trash2 size={13} />
                          </button>
                        </td>
                      </tr>
                      {expandedDlqJob === job.id && (
                        <tr className="bg-elevated border-b-2 border-red-500/30">
                          <td colSpan={6} className="px-8 py-6">
                            <div className="space-y-4">
                              <div className="flex justify-between items-center">
                                <div className="text-xs font-bold uppercase tracking-widest text-red-400 flex items-center gap-1.5">
                                  <AlertTriangle size={14} /> Full Exception Stack Trace & Diagnostics
                                </div>
                                <span className="font-mono text-xs text-muted">Job ID: {job.id}</span>
                              </div>
                              <pre className="p-4 rounded-xl bg-card border border-subtle text-xs font-mono text-red-400/90 whitespace-pre-wrap overflow-x-auto max-h-48">
                                {job.stacktrace?.length ? job.stacktrace.join('\n') : job.failedReason}
                              </pre>
                              <div>
                                <div className="text-[10px] font-bold uppercase tracking-widest text-muted mb-1">Original Job Payload</div>
                                <pre className="p-3 rounded-xl bg-base border border-subtle text-xs font-mono text-muted whitespace-pre-wrap">
                                  {JSON.stringify(job.data, null, 2)}
                                </pre>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
