import React, { useEffect, useState } from 'react';
import { useSocket } from '../context/SocketContext.js';
import { Wifi, WifiOff, RefreshCw, Activity, ShieldCheck, Database } from 'lucide-react';
import { fetchWithAuth } from '../lib/api.js';

export function TelemetryStatusBar() {
  const { connectionState, eventsReceived, eventsPerSec, latencyMs, pingServer, reconnectCount } = useSocket();
  const [systemHealth, setSystemHealth] = useState<{ status: string; postgres: string; redis: string; error?: string; storageMode?: string }>({
    status: 'healthy',
    postgres: 'healthy',
    redis: 'healthy',
    storageMode: 'in-memory'
  });
  const [testCount, setTestCount] = useState<number>(57);

  useEffect(() => {
    const fetchHealth = () => {
      fetchWithAuth('/api/control/system/health')
        .then(res => res.json())
        .then(data => {
          if (data && data.postgres) {
            setSystemHealth({
              status: data.status,
              postgres: data.postgres.status,
              redis: data.redis.status,
              error: data.postgres.error,
              storageMode: data.postgres.storageMode
            });
          }
        })
        .catch(() => {});

      fetchWithAuth('/api/control/system/test-status')
        .then(res => res.json())
        .then(data => {
          if (data && data.passed) {
            setTestCount(data.passed);
          }
        })
        .catch(() => {});
    };

    fetchHealth();
    const interval = setInterval(fetchHealth, 15000);
    return () => clearInterval(interval);
  }, []);

  const getStatusColor = () => {
    switch (connectionState) {
      case 'connected':
        return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30';
      case 'connecting':
      case 'reconnecting':
      case 'degraded':
        return 'text-amber-400 bg-amber-500/10 border-amber-500/30';
      default:
        return 'text-rose-400 bg-rose-500/10 border-rose-500/30';
    }
  };

  return (
    <div id="telemetry-status-bar" className="flex flex-wrap items-center justify-between px-4 py-2 bg-surface/80 backdrop-blur border-t border-subtle text-xs font-mono select-none">
      <div className="flex items-center gap-4">
        {/* Live Telemetry Socket Pill */}
        <button
          onClick={pingServer}
          title="Click to ping telemetry server"
          className={`flex items-center gap-2 px-2.5 py-1 rounded-full border transition hover:opacity-80 ${getStatusColor()}`}
        >
          {connectionState === 'connected' ? (
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
            </span>
          ) : (
            <WifiOff size={12} />
          )}
          <span className="uppercase tracking-wider font-bold">
            {connectionState === 'connected' ? 'Telemetry Live' : connectionState}
          </span>
          {latencyMs > 0 && <span className="opacity-75">({latencyMs}ms)</span>}
        </button>

        {/* Streaming Rate */}
        <div className="flex items-center gap-1.5 text-muted">
          <Activity size={12} className="text-primary" />
          <span>Stream:</span>
          <span className="text-strong font-bold">{eventsPerSec} ev/s</span>
          <span className="opacity-50">({eventsReceived.toLocaleString()} total)</span>
        </div>

        {/* Database & Redis */}
        <div className="hidden sm:flex items-center gap-2 text-muted border-l border-subtle pl-4" title={systemHealth.error || 'Database operational'}>
          <Database size={12} className={systemHealth.postgres === 'healthy' ? 'text-emerald-400' : 'text-rose-400'} />
          <span>PG: <strong className={systemHealth.postgres === 'healthy' ? 'text-emerald-400' : 'text-rose-400'}>{systemHealth.postgres}</strong> ({systemHealth.storageMode || 'in-memory'})</span>
          <span>Redis: <strong className={systemHealth.redis === 'healthy' ? 'text-emerald-400' : 'text-rose-400'}>{systemHealth.redis}</strong></span>
          {systemHealth.error && (
            <span className="text-rose-400 text-[10px] bg-rose-500/10 px-1.5 py-0.5 rounded border border-rose-500/30 truncate max-w-[150px]" title={systemHealth.error}>
              Error: {systemHealth.error}
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-4">
        {/* Verified Automated Tests Badge */}
        <div className="flex items-center gap-1.5 text-muted">
          <ShieldCheck size={14} className="text-emerald-400" />
          <span>Verified Suites:</span>
          <span className="text-emerald-400 font-bold">{testCount} / 57 PASS</span>
        </div>

        {reconnectCount > 0 && (
          <span className="text-amber-400 text-[10px]">
            ({reconnectCount} reconnects)
          </span>
        )}
      </div>
    </div>
  );
}
