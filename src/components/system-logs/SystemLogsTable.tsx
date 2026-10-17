import React, { useEffect, useState, useRef, useCallback } from 'react';
import { fetchWithAuth } from "../../lib/api.js";
import { Terminal, AlertTriangle, Info, AlertOctagon, ArrowUpDown, Filter, Search } from 'lucide-react';
import { LogDetailDrawer } from './LogDetailDrawer.js';
import { useProject } from '../../context/ProjectContext.js';

export function SystemLogs() {
  const { currentProject } = useProject();
  const [logs, setLogs] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(false);
  
  // Filtering and Search
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [severityFilter, setSeverityFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  
  // Drawer state
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const projectId = currentProject?.id || localStorage.getItem('fortix_project_id') || '';

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
    }, 500);
    return () => clearTimeout(timer);
  }, [search]);

  const fetchLogs = useCallback(async (isSilent = false) => {
    if (!isSilent) setIsLoading(true);
    setError(false);
    try {
      const params = new URLSearchParams({ projectId, limit: '50', offset: '0' });
      if (severityFilter) params.set('severity', severityFilter);
      if (typeFilter) params.set('type', typeFilter);
      if (debouncedSearch) params.set('search', debouncedSearch);
      
      const res = await fetchWithAuth(`/api/control/events?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        setLogs(data.events || []);
        setTotal(data.total || 0);
      } else {
        setError(true);
      }
    } catch (err) {
      setError(true);
    } finally {
      if (!isSilent) setIsLoading(false);
    }
  }, [projectId, severityFilter, typeFilter, debouncedSearch]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  // Live polling (silent updates)
  useEffect(() => {
    const interval = setInterval(() => {
      fetchLogs(true);
    }, 5000);
    return () => clearInterval(interval);
  }, [fetchLogs]);

  const getLogColor = (severity: string) => {
    switch(severity) {
      case 'CRITICAL': return 'text-red-500';
      case 'HIGH': return 'text-primary';
      case 'MEDIUM': return 'text-yellow-400';
      default: return 'text-blue-400';
    }
  };

  const getIcon = (severity: string) => {
    switch(severity) {
      case 'CRITICAL': return <AlertOctagon size={12} className="text-red-500" />;
      case 'HIGH': return <AlertTriangle size={12} className="text-primary" />;
      case 'MEDIUM': return <AlertTriangle size={12} className="text-yellow-400" />;
      default: return <Info size={12} className="text-blue-400" />;
    }
  };

  return (
    <div className="relative bg-surface border border-subtle rounded-lg flex flex-col overflow-hidden h-full">
      {/* Header & Toolbar */}
      <div className="px-4 py-3 border-b border-subtle bg-card flex flex-col sm:flex-row justify-between sm:items-center gap-3">
        <div className="flex items-center gap-2">
          <Terminal size={14} className="text-muted" />
          <h2 className="text-xs font-bold uppercase tracking-widest text-base-text">System Logs</h2>
          <div className="flex items-center gap-1.5 ml-2 bg-border/50 px-2 py-0.5 rounded">
            <div className={`w-1.5 h-1.5 rounded-full ${error ? 'bg-red-500' : 'bg-green-500 animate-pulse'}`}></div>
            <span className="text-[10px] font-mono text-muted">{error ? 'CONNECTION LOST' : 'LIVE'}</span>
          </div>
        </div>
        
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search size={12} className="absolute left-2.5 top-2 text-muted" />
            <input 
              type="text" 
              placeholder="Search logs..." 
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-7 pr-3 py-1.5 bg-base border border-subtle rounded text-xs text-strong focus:outline-none focus:border-primary transition"
            />
          </div>
          <select 
            value={severityFilter}
            onChange={e => setSeverityFilter(e.target.value)}
            className="px-2 py-1.5 bg-base border border-subtle rounded text-xs text-base-text focus:outline-none focus:border-primary"
          >
            <option value="">All Severities</option>
            <option value="CRITICAL">Critical</option>
            <option value="HIGH">High / Warn</option>
            <option value="MEDIUM">Medium / Warn</option>
            <option value="LOW">Info</option>
          </select>
          <select 
            value={typeFilter}
            onChange={e => setTypeFilter(e.target.value)}
            className="px-2 py-1.5 bg-base border border-subtle rounded text-xs text-base-text focus:outline-none focus:border-primary"
          >
            <option value="">All Events</option>
            <option value="RATE_LIMIT_EXCEEDED">Rate Limit</option>
            <option value="PATH_TRAVERSAL">Path Traversal</option>
            <option value="INVALID_API_KEY">Invalid API Key</option>
            <option value="EXPERIMENT_STARTED">Experiment Started</option>
            <option value="EXPERIMENT_COMPLETED">Experiment Completed</option>
          </select>
        </div>
      </div>
      
      {/* Table Header */}
      <div className="grid grid-cols-12 gap-2 px-4 py-2 border-b border-subtle bg-card/50 text-[10px] font-bold uppercase tracking-widest text-muted">
        <div className="col-span-3">Timestamp</div>
        <div className="col-span-2">Severity</div>
        <div className="col-span-4">Event</div>
        <div className="col-span-1">Status</div>
        <div className="col-span-2">Source</div>
      </div>
      
      {/* Table Body */}
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-1 font-mono text-xs">
        {isLoading && logs.length === 0 ? (
          <div className="flex flex-col gap-2">
            {[1,2,3,4,5].map(i => (
              <div key={i} className="h-8 bg-card animate-pulse rounded border border-subtle/50"></div>
            ))}
          </div>
        ) : error && logs.length === 0 ? (
          <div className="text-center py-8">
            <AlertTriangle className="text-red-500 mx-auto mb-2" size={24} />
            <div className="text-sm font-bold text-strong mb-1">UNABLE TO LOAD SYSTEM LOGS</div>
            <div className="text-xs text-muted mb-4">The telemetry service could not be reached.</div>
            <button onClick={() => fetchLogs()} className="px-4 py-1.5 bg-border hover:bg-hover transition rounded text-xs text-strong">Retry</button>
          </div>
        ) : logs.length === 0 ? (
          <div className="text-center py-8">
            <div className="text-sm font-bold text-base-text mb-1">NO SECURITY EVENTS</div>
            <div className="text-xs text-muted">No events match the current filters.</div>
          </div>
        ) : (
          logs.map((log) => (
            <div 
              key={log.id} 
              onClick={() => setSelectedEventId(log.id)}
              className="grid grid-cols-12 gap-2 items-center py-1.5 border-b border-subtle/30 last:border-0 hover:bg-hover transition px-2 -mx-2 rounded cursor-pointer group"
            >
              <div className="col-span-3 text-[#4A4A4C] group-hover:text-muted transition">
                {new Date(log.timestamp).toLocaleTimeString()}
              </div>
              <div className="col-span-2 flex items-center gap-1.5">
                {getIcon(log.severity)}
                <span className={`font-bold ${getLogColor(log.severity)}`}>{log.severity}</span>
              </div>
              <div className="col-span-4 text-base-text font-bold truncate group-hover:text-strong transition">
                {log.type}
              </div>
              <div className="col-span-1">
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-widest ${
                  log.action === 'BLOCKED' ? 'bg-red-500/10 text-red-500' : 
                  'bg-blue-500/10 text-blue-400'
                }`}>
                  {log.action}
                </span>
              </div>
              <div className="col-span-2 text-muted truncate text-[10px]">
                {log.sourceIp || 'FortiX Gateway'}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Drawer */}
      <LogDetailDrawer 
        eventId={selectedEventId} 
        projectId={projectId} 
        onClose={() => setSelectedEventId(null)}
        onRelatedClick={(id) => setSelectedEventId(id)}
      />
    </div>
  );
}
