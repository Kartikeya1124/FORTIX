import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import {
  Shield,
  ShieldCheck,
  Lock,
  Plus,
  Search,
  Edit3,
  Trash2,
  X,
  AlertCircle,
  CheckCircle2,
  Sliders,
  Eye,
  Gauge,
  ArrowUpRight
} from 'lucide-react';
import { fetchWithAuth } from '../lib/api.js';
import { useProject } from '../context/ProjectContext.js';

interface RouteItem {
  id: string;
  projectId: string;
  pathPattern: string;
  targetUrl: string;
  createdAt?: string;
}

interface SecurityPolicyItem {
  id: string;
  routeId: string;
  pathPattern?: string;
  targetUrl?: string;
  rateLimitRpm: number | null;
  enableWaf: boolean;
  enableSsrf: boolean;
  createdAt?: string;
}

interface ProjectBaseline {
  defaultRpm: number;
  failureMode: string;
  upstreamTimeoutMs: number;
}

type FilterMode = 'all' | 'rate_limited' | 'waf' | 'ssrf';

export default function Security() {
  const { currentProject } = useProject();
  const projectId = currentProject?.id || localStorage.getItem('fortix_project_id') || '';

  const [policies, setPolicies] = useState<SecurityPolicyItem[]>([]);
  const [routes, setRoutes] = useState<RouteItem[]>([]);
  const [baseline, setBaseline] = useState<ProjectBaseline>({
    defaultRpm: 60,
    failureMode: 'FAIL_CLOSED',
    upstreamTimeoutMs: 5000
  });
  const [isLoading, setIsLoading] = useState(true);
  const [pageError, setPageError] = useState('');
  const [feedbackBanner, setFeedbackBanner] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Search & filter state
  const [searchTerm, setSearchTerm] = useState('');
  const [filterMode, setFilterMode] = useState<FilterMode>('all');

  // Inline delete confirmation state
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Composer Modal state
  const [isComposerOpen, setIsComposerOpen] = useState(false);
  const [isEditingExisting, setIsEditingExisting] = useState(false);
  const [selectedRouteId, setSelectedRouteId] = useState('');
  const [useCustomRpm, setUseCustomRpm] = useState(true);
  const [rpmInput, setRpmInput] = useState<string>('60');
  const [enableWaf, setEnableWaf] = useState(true);
  const [enableSsrf, setEnableSsrf] = useState(true);
  const [composerError, setComposerError] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const fetchData = useCallback(async () => {
    if (!projectId) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setPageError('');
    try {
      const [polRes, routeRes, settingsRes] = await Promise.all([
        fetchWithAuth(`/api/control/policies?projectId=${encodeURIComponent(projectId)}`),
        fetchWithAuth(`/api/control/routes?projectId=${encodeURIComponent(projectId)}`),
        fetchWithAuth(`/api/control/settings?projectId=${encodeURIComponent(projectId)}`)
      ]);

      if (polRes.ok) {
        const polData = await polRes.json();
        setPolicies(Array.isArray(polData) ? polData : []);
      }
      if (routeRes.ok) {
        const routeData = await routeRes.json();
        setRoutes(Array.isArray(routeData) ? routeData : []);
      }
      if (settingsRes.ok) {
        const sData = await settingsRes.json();
        const defaultRpm =
          sData?.rateLimitConfig?.defaultRpm ??
          sData?.rateLimitConfig?.requestsPerMinute ??
          60;
        const failureMode = sData?.rateLimitConfig?.failureMode || 'FAIL_CLOSED';
        const upstreamTimeoutMs = sData?.gatewayConfig?.upstreamTimeoutMs ?? 5000;
        setBaseline({ defaultRpm, failureMode, upstreamTimeoutMs });
      }
    } catch {
      setPageError('Failed to load security policies for this project.');
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Close composer modal on Escape
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && isComposerOpen) {
        setIsComposerOpen(false);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isComposerOpen]);

  const policyByRouteId = useMemo(() => {
    const map = new Map<string, SecurityPolicyItem>();
    for (const p of policies) {
      map.set(p.routeId, p);
    }
    return map;
  }, [policies]);

  const routeById = useMemo(() => {
    const map = new Map<string, RouteItem>();
    for (const r of routes) {
      map.set(r.id, r);
    }
    return map;
  }, [routes]);

  const unassignedRoutes = useMemo(
    () => routes.filter(r => !policyByRouteId.has(r.id)),
    [routes, policyByRouteId]
  );

  const openNewComposer = (preselectedRouteId?: string) => {
    setComposerError('');
    const initialRouteId = preselectedRouteId || unassignedRoutes[0]?.id || routes[0]?.id || '';
    const existing = initialRouteId ? policyByRouteId.get(initialRouteId) : undefined;

    setSelectedRouteId(initialRouteId);
    if (existing) {
      setIsEditingExisting(true);
      setUseCustomRpm(typeof existing.rateLimitRpm === 'number');
      setRpmInput(String(existing.rateLimitRpm ?? baseline.defaultRpm));
      setEnableWaf(Boolean(existing.enableWaf));
      setEnableSsrf(Boolean(existing.enableSsrf));
    } else {
      setIsEditingExisting(false);
      setUseCustomRpm(true);
      setRpmInput(String(baseline.defaultRpm || 60));
      setEnableWaf(true);
      setEnableSsrf(true);
    }
    setIsComposerOpen(true);
  };

  const openEditComposer = (policy: SecurityPolicyItem) => {
    setComposerError('');
    setSelectedRouteId(policy.routeId);
    setIsEditingExisting(true);
    setUseCustomRpm(typeof policy.rateLimitRpm === 'number');
    setRpmInput(String(policy.rateLimitRpm ?? baseline.defaultRpm));
    setEnableWaf(Boolean(policy.enableWaf));
    setEnableSsrf(Boolean(policy.enableSsrf));
    setIsComposerOpen(true);
  };

  const handleRouteSelectionChange = (nextRouteId: string) => {
    setSelectedRouteId(nextRouteId);
    setComposerError('');
    const existing = policyByRouteId.get(nextRouteId);
    if (existing) {
      setIsEditingExisting(true);
      setUseCustomRpm(typeof existing.rateLimitRpm === 'number');
      setRpmInput(String(existing.rateLimitRpm ?? baseline.defaultRpm));
      setEnableWaf(Boolean(existing.enableWaf));
      setEnableSsrf(Boolean(existing.enableSsrf));
    } else {
      setIsEditingExisting(false);
    }
  };

  const applyPreset = (preset: 'strict' | 'balanced' | 'high_throughput' | 'ssrf_waf_only') => {
    setComposerError('');
    if (preset === 'strict') {
      setUseCustomRpm(true);
      setRpmInput('30');
      setEnableWaf(true);
      setEnableSsrf(true);
    } else if (preset === 'balanced') {
      setUseCustomRpm(true);
      setRpmInput('60');
      setEnableWaf(true);
      setEnableSsrf(true);
    } else if (preset === 'high_throughput') {
      setUseCustomRpm(true);
      setRpmInput('300');
      setEnableWaf(true);
      setEnableSsrf(false);
    } else {
      setUseCustomRpm(false);
      setEnableWaf(true);
      setEnableSsrf(true);
    }
  };

  const handleSavePolicy = async (e: React.FormEvent) => {
    e.preventDefault();
    setComposerError('');

    if (!selectedRouteId) {
      setComposerError('Select a target gateway route to protect.');
      return;
    }

    let parsedRpm: number | null = null;
    if (useCustomRpm) {
      const numeric = Number.parseInt(rpmInput, 10);
      if (!Number.isFinite(numeric) || numeric < 1 || numeric > 100000) {
        setComposerError('Rate limit must be an integer between 1 and 100,000 requests per minute.');
        return;
      }
      parsedRpm = numeric;
    }

    setIsSaving(true);
    try {
      const res = await fetchWithAuth('/api/control/policies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          routeId: selectedRouteId,
          rateLimitRpm: parsedRpm,
          enableWaf,
          enableSsrf
        })
      });

      if (res.ok) {
        const targetRoute = routeById.get(selectedRouteId);
        setIsComposerOpen(false);
        setFeedbackBanner({
          type: 'success',
          message: `Saved security policy for ${targetRoute?.pathPattern || 'selected route'}.`
        });
        await fetchData();
      } else {
        const errData = await res.json().catch(() => ({}));
        setComposerError(errData.error || 'Failed to save security policy.');
      }
    } catch {
      setComposerError('Network error while saving security policy.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeletePolicy = async (policy: SecurityPolicyItem) => {
    setDeletingId(policy.id);
    setFeedbackBanner(null);
    try {
      const res = await fetchWithAuth(
        `/api/control/policies/${encodeURIComponent(policy.id)}?projectId=${encodeURIComponent(projectId)}`,
        { method: 'DELETE' }
      );
      if (res.ok) {
        const route = routeById.get(policy.routeId);
        setConfirmDeleteId(null);
        setFeedbackBanner({
          type: 'success',
          message: `Removed custom route policy for ${policy.pathPattern || route?.pathPattern || policy.routeId}. Route now inherits project baseline defaults.`
        });
        await fetchData();
      } else {
        const errData = await res.json().catch(() => ({}));
        setFeedbackBanner({
          type: 'error',
          message: errData.error || 'Failed to delete security policy.'
        });
      }
    } catch {
      setFeedbackBanner({
        type: 'error',
        message: 'Network error while deleting security policy.'
      });
    } finally {
      setDeletingId(null);
    }
  };

  const filteredPolicies = useMemo(() => {
    return policies.filter(p => {
      const route = routeById.get(p.routeId);
      const pathStr = (p.pathPattern || route?.pathPattern || '').toLowerCase();
      const targetStr = (p.targetUrl || route?.targetUrl || '').toLowerCase();
      const q = searchTerm.trim().toLowerCase();

      if (q && !pathStr.includes(q) && !targetStr.includes(q) && !p.routeId.toLowerCase().includes(q)) {
        return false;
      }
      if (filterMode === 'rate_limited' && typeof p.rateLimitRpm !== 'number') return false;
      if (filterMode === 'waf' && !p.enableWaf) return false;
      if (filterMode === 'ssrf' && !p.enableSsrf) return false;
      return true;
    });
  }, [policies, routeById, searchTerm, filterMode]);

  const wafActiveCount = useMemo(
    () => policies.filter(p => p.enableWaf).length + unassignedRoutes.length,
    [policies, unassignedRoutes]
  );

  const ssrfDeepCount = useMemo(
    () => policies.filter(p => p.enableSsrf).length,
    [policies]
  );

  return (
    <div className="space-y-8 max-w-7xl mx-auto">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-zinc-950 dark:text-white">
            Security Policies
          </h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1 max-w-2xl">
            Enforce per-route token-bucket rate limits, SQLi/XSS WAF blocking, and deep parameter SSRF inspection across{' '}
            <span className="font-semibold text-zinc-900 dark:text-zinc-200">
              {currentProject?.name || 'active workspace'}
            </span>.
          </p>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <Link
            to="/settings"
            className="px-3.5 py-2 rounded-xl border border-zinc-300 dark:border-white/15 bg-white dark:bg-[#141722] hover:bg-zinc-50 dark:hover:bg-[#1b2030] text-xs font-semibold text-zinc-800 dark:text-zinc-200 transition-colors flex items-center gap-1.5 whitespace-nowrap"
          >
            <Sliders size={14} className="text-primary" />
            <span>Project Defaults</span>
          </Link>
          <button
            type="button"
            onClick={() => openNewComposer()}
            disabled={routes.length === 0}
            className="px-4 py-2 rounded-xl bg-primary hover:bg-primary-hover disabled:opacity-50 text-zinc-950 text-xs font-semibold transition-colors flex items-center gap-1.5 shadow-sm whitespace-nowrap"
          >
            <Plus size={15} />
            <span>Configure Route Policy</span>
          </button>
        </div>
      </div>

      {/* Feedback Banner */}
      {feedbackBanner && (
        <div
          role="status"
          className={`flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-xs font-medium ${
            feedbackBanner.type === 'success'
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-300'
              : 'bg-red-500/10 border-red-500/35 text-red-700 dark:text-red-300'
          }`}
        >
          <div className="flex items-center gap-2.5">
            {feedbackBanner.type === 'success' ? (
              <CheckCircle2 size={15} className="text-emerald-500 dark:text-emerald-400 shrink-0" />
            ) : (
              <AlertCircle size={15} className="text-red-500 dark:text-red-400 shrink-0" />
            )}
            <span>{feedbackBanner.message}</span>
          </div>
          <button
            type="button"
            onClick={() => setFeedbackBanner(null)}
            aria-label="Dismiss notification"
            className="p-1 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {pageError && (
        <div
          role="alert"
          className="flex items-center gap-2.5 rounded-xl bg-red-500/10 border border-red-500/35 px-4 py-3 text-xs text-red-600 dark:text-red-300"
        >
          <AlertCircle size={15} className="shrink-0" />
          <span>{pageError}</span>
        </div>
      )}

      {/* Single-Elevation Summary Strip */}
      <div className="rounded-2xl border border-zinc-200 dark:border-white/12 bg-white dark:bg-[#131622] grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-zinc-200 dark:divide-white/10 overflow-hidden">
        <div className="p-5">
          <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Custom Route Policies</div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold font-mono tabular-nums text-zinc-950 dark:text-white">
              {policies.length}
            </span>
            <span className="text-xs text-zinc-500 dark:text-zinc-400 tabular-nums">
              of {routes.length} routes
            </span>
          </div>
          <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400 tabular-nums">
            {unassignedRoutes.length} inheriting baseline defaults
          </div>
        </div>

        <div className="p-5">
          <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400">WAF Blocking Coverage</div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold font-mono tabular-nums text-emerald-600 dark:text-emerald-400">
              {wafActiveCount}
            </span>
            <span className="text-xs text-zinc-500 dark:text-zinc-400 tabular-nums">
              / {routes.length} routes
            </span>
          </div>
          <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            SQLi, XSS & traversal inspection
          </div>
        </div>

        <div className="p-5">
          <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Deep Parameter SSRF Guard</div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold font-mono tabular-nums text-zinc-950 dark:text-white">
              {ssrfDeepCount}
            </span>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              routes with param scan
            </span>
          </div>
          <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            Upstream SSRF always enforced
          </div>
        </div>

        <div className="p-5">
          <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Project Baseline Posture</div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold font-mono tabular-nums text-primary">
              {baseline.defaultRpm}
            </span>
            <span className="text-xs font-mono text-zinc-500 dark:text-zinc-400">
              RPM default
            </span>
          </div>
          <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400 font-mono tabular-nums">
            {baseline.failureMode} · {baseline.upstreamTimeoutMs}ms timeout
          </div>
        </div>
      </div>

      {/* Filter & Search Toolbar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="relative flex-1 max-w-md">
          <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-400 dark:text-zinc-500 pointer-events-none" />
          <input
            type="text"
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            placeholder="Search policies by route path or target URL..."
            className="w-full rounded-xl bg-white dark:bg-[#0d1017] border border-zinc-300 dark:border-white/20 pl-10 pr-3.5 py-2 text-xs sm:text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:border-primary transition-colors"
          />
        </div>

        <div className="flex items-center gap-1 p-1 rounded-xl bg-zinc-100 dark:bg-[#0d1017] border border-zinc-200 dark:border-white/12 self-start md:self-auto overflow-x-auto max-w-full">
          {(
            [
              { id: 'all', label: `All (${policies.length})` },
              { id: 'rate_limited', label: 'Custom RPM' },
              { id: 'waf', label: 'WAF Blocking' },
              { id: 'ssrf', label: 'Deep SSRF' }
            ] as const
          ).map(tab => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setFilterMode(tab.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 tabular-nums ${
                filterMode === tab.id
                  ? 'bg-white dark:bg-[#1b2030] text-zinc-950 dark:text-white shadow-sm'
                  : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-950 dark:hover:text-zinc-200'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Main Policies Table / States */}
      <div className="rounded-2xl border border-zinc-200 dark:border-white/12 bg-white dark:bg-[#131622] overflow-hidden">
        {isLoading ? (
          <div className="p-6 space-y-3">
            {[1, 2, 3].map(idx => (
              <div
                key={idx}
                className="h-12 rounded-xl bg-zinc-100 dark:bg-white/5 animate-pulse"
              />
            ))}
          </div>
        ) : routes.length === 0 ? (
          <div className="p-10 text-center space-y-3">
            <Shield size={28} className="mx-auto text-zinc-400 dark:text-zinc-500" />
            <h3 className="text-base font-semibold text-zinc-950 dark:text-white">
              No Protected API Routes Registered Yet
            </h3>
            <p className="text-xs sm:text-sm text-zinc-500 dark:text-zinc-400 max-w-md mx-auto">
              Register an upstream API route first to attach per-route rate limits, WAF blocking rules, and deep parameter SSRF guards.
            </p>
            <div className="pt-2 flex items-center justify-center gap-3">
              <Link
                to="/apis"
                className="px-4 py-2 rounded-xl bg-primary hover:bg-primary-hover text-zinc-950 text-xs font-semibold transition-colors inline-flex items-center gap-1.5"
              >
                <span>Register Protected Route</span>
                <ArrowUpRight size={14} />
              </Link>
              <Link
                to="/directory"
                className="px-4 py-2 rounded-xl border border-zinc-300 dark:border-white/15 bg-zinc-50 dark:bg-[#0d1017] hover:bg-zinc-100 dark:hover:bg-[#1a1f2e] text-zinc-800 dark:text-zinc-200 text-xs font-semibold transition-colors"
              >
                Browse 800+ Public APIs
              </Link>
            </div>
          </div>
        ) : filteredPolicies.length === 0 ? (
          <div className="p-10 text-center space-y-3">
            <ShieldCheck size={28} className="mx-auto text-primary" />
            <h3 className="text-base font-semibold text-zinc-950 dark:text-white">
              {policies.length === 0
                ? 'No Route-Specific Overrides Configured'
                : 'No Policies Match Current Filter'}
            </h3>
            <p className="text-xs sm:text-sm text-zinc-500 dark:text-zinc-400 max-w-lg mx-auto">
              {policies.length === 0
                ? `All ${routes.length} registered routes currently inherit the project baseline (${baseline.defaultRpm} RPM · WAF blocking · upstream SSRF protection). Attach a policy below to customize a specific route.`
                : 'Clear your search query or switch filter tabs to view all configured route policies.'}
            </p>
            <div className="pt-2">
              {policies.length === 0 ? (
                <button
                  type="button"
                  onClick={() => openNewComposer()}
                  className="px-4 py-2 rounded-xl bg-primary hover:bg-primary-hover text-zinc-950 text-xs font-semibold transition-colors inline-flex items-center gap-1.5"
                >
                  <Plus size={14} />
                  <span>Create First Route Policy</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setSearchTerm('');
                    setFilterMode('all');
                  }}
                  className="px-4 py-2 rounded-xl border border-zinc-300 dark:border-white/15 bg-zinc-50 dark:bg-[#0d1017] text-xs font-semibold text-zinc-800 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-[#1b2030] transition-colors"
                >
                  Reset Filters
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-zinc-200 dark:border-white/10 bg-zinc-50/80 dark:bg-[#0e111a] text-[11px] font-semibold text-zinc-500 dark:text-zinc-400">
                  <th className="py-3 px-5">Protected Route</th>
                  <th className="py-3 px-4 text-right">Rate Limit Cap</th>
                  <th className="py-3 px-4">WAF Threat Inspection</th>
                  <th className="py-3 px-4">SSRF Protection</th>
                  <th className="py-3 px-5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 dark:divide-white/10 text-xs sm:text-sm">
                {filteredPolicies.map(policy => {
                  const route = routeById.get(policy.routeId);
                  const pathPattern = policy.pathPattern || route?.pathPattern || policy.routeId;
                  const targetUrl = policy.targetUrl || route?.targetUrl || 'Upstream route';
                  const isConfirmingDelete = confirmDeleteId === policy.id;

                  return (
                    <tr
                      key={policy.id}
                      className="hover:bg-zinc-50/80 dark:hover:bg-white/[0.03] transition-colors"
                    >
                      <td className="py-3.5 px-5 max-w-xs">
                        <div className="font-mono font-semibold text-zinc-950 dark:text-white truncate">
                          {pathPattern}
                        </div>
                        <div className="text-xs text-zinc-500 dark:text-zinc-400 truncate mt-0.5 font-mono">
                          {targetUrl}
                        </div>
                      </td>

                      <td className="py-3.5 px-4 text-right font-mono tabular-nums whitespace-nowrap">
                        {typeof policy.rateLimitRpm === 'number' ? (
                          <span className="font-semibold text-zinc-950 dark:text-white">
                            {policy.rateLimitRpm.toLocaleString()} RPM
                          </span>
                        ) : (
                          <span className="text-xs text-zinc-500 dark:text-zinc-400">
                            Baseline ({baseline.defaultRpm} RPM)
                          </span>
                        )}
                      </td>

                      <td className="py-3.5 px-4 whitespace-nowrap">
                        {policy.enableWaf ? (
                          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                            <ShieldCheck size={14} className="shrink-0" />
                            <span>Blocking (403)</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-600 dark:text-amber-400">
                            <Eye size={14} className="shrink-0" />
                            <span>Monitor Only</span>
                          </span>
                        )}
                      </td>

                      <td className="py-3.5 px-4 whitespace-nowrap">
                        {policy.enableSsrf ? (
                          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                            <Lock size={14} className="shrink-0" />
                            <span>Upstream + Params</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
                            <Shield size={14} className="shrink-0" />
                            <span>Upstream Target</span>
                          </span>
                        )}
                      </td>

                      <td className="py-3.5 px-5 text-right whitespace-nowrap">
                        {isConfirmingDelete ? (
                          <div className="inline-flex items-center justify-end gap-2">
                            <button
                              type="button"
                              disabled={deletingId === policy.id}
                              onClick={() => handleDeletePolicy(policy)}
                              className="px-2.5 py-1 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-semibold transition-colors disabled:opacity-50"
                            >
                              {deletingId === policy.id ? 'Removing...' : 'Confirm'}
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(null)}
                              className="px-2.5 py-1 rounded-lg border border-zinc-300 dark:border-white/15 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-white/10 transition-colors"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <div className="inline-flex items-center justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => openEditComposer(policy)}
                              className="px-2.5 py-1.5 rounded-lg border border-zinc-300 dark:border-white/15 bg-zinc-50 dark:bg-[#0d1017] hover:bg-zinc-100 dark:hover:bg-[#1c2132] text-xs font-medium text-zinc-800 dark:text-zinc-200 transition-colors inline-flex items-center gap-1"
                            >
                              <Edit3 size={12} />
                              <span>Edit</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(policy.id)}
                              className="px-2.5 py-1.5 rounded-lg border border-transparent hover:border-red-500/30 hover:bg-red-500/10 text-xs font-medium text-zinc-500 dark:text-zinc-400 hover:text-red-500 dark:hover:text-red-400 transition-colors inline-flex items-center gap-1"
                            >
                              <Trash2 size={12} />
                              <span>Remove</span>
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Unassigned Routes Inheriting Baseline Defaults */}
      {unassignedRoutes.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-zinc-950 dark:text-white">
                Routes Using Baseline Project Defaults ({unassignedRoutes.length})
              </h3>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                These routes automatically enforce API key authentication, WAF blocking, upstream SSRF checks, and {baseline.defaultRpm} RPM rate limits.
              </p>
            </div>
          </div>

          <div className="rounded-2xl border border-zinc-200 dark:border-white/12 bg-white dark:bg-[#131622] divide-y divide-zinc-200 dark:divide-white/10 overflow-hidden">
            {unassignedRoutes.map(route => (
              <div
                key={route.id}
                className="px-5 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-zinc-50/70 dark:hover:bg-white/[0.02] transition-colors"
              >
                <div className="min-w-0">
                  <div className="text-sm font-mono font-semibold text-zinc-900 dark:text-zinc-100 truncate">
                    {route.pathPattern}
                  </div>
                  <div className="text-xs font-mono text-zinc-500 dark:text-zinc-400 truncate mt-0.5">
                    {route.targetUrl} · Baseline {baseline.defaultRpm} RPM · WAF Blocking
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => openNewComposer(route.id)}
                  className="px-3 py-1.5 rounded-xl border border-zinc-300 dark:border-white/15 bg-zinc-50 dark:bg-[#0d1017] hover:border-primary/60 hover:text-primary text-xs font-semibold text-zinc-800 dark:text-zinc-200 transition-colors inline-flex items-center gap-1.5 self-start sm:self-auto shrink-0 whitespace-nowrap"
                >
                  <Plus size={13} className="text-primary" />
                  <span>Attach Custom Policy</span>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Full-Screen Blurred Policy Composer Modal (Solid Night Mode Surface) */}
      {isComposerOpen && typeof document !== 'undefined' && createPortal(
        <div
          className="fixed inset-0 z-[9998] flex items-center justify-center p-4 bg-black/75 backdrop-blur-md"
          onClick={() => setIsComposerOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Configure Route Security Policy"
        >
          <div
            className="w-full max-w-xl max-h-[90vh] flex flex-col rounded-2xl bg-white dark:bg-[#141722] border border-zinc-200 dark:border-white/15 shadow-2xl overflow-hidden text-zinc-900 dark:text-zinc-100"
            onClick={e => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-zinc-200 dark:border-white/12 bg-zinc-50 dark:bg-[#10131c] flex items-center justify-between shrink-0">
              <div>
                <h3 className="text-base font-bold text-zinc-950 dark:text-white flex items-center gap-2">
                  <Shield size={18} className="text-primary shrink-0" />
                  <span>{isEditingExisting ? 'Edit Route Security Policy' : 'Configure Route Security Policy'}</span>
                </h3>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                  Define custom rate limits, WAF enforcement, and parameter-level SSRF inspection for a gateway route.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsComposerOpen(false)}
                aria-label="Close modal"
                className="p-1.5 rounded-lg text-zinc-500 dark:text-zinc-400 hover:text-zinc-950 dark:hover:text-white hover:bg-zinc-200/60 dark:hover:bg-white/10 transition-colors"
              >
                <X size={16} />
              </button>
            </div>

            {composerError && (
              <div
                role="alert"
                className="mx-6 mt-4 flex items-start gap-2.5 rounded-xl bg-red-500/12 border border-red-500/35 px-3.5 py-3 text-xs text-red-600 dark:text-red-300 shrink-0"
              >
                <AlertCircle size={15} className="shrink-0 mt-0.5" />
                <span>{composerError}</span>
              </div>
            )}

            <form onSubmit={handleSavePolicy} className="flex flex-col flex-1 min-h-0 overflow-hidden">
              <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
                {/* Target Route Select */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label htmlFor="policy-route-select" className="block text-xs font-semibold text-zinc-800 dark:text-zinc-200">
                      Target Protected Route <span className="text-red-500">*</span>
                    </label>
                    {isEditingExisting && (
                      <span className="text-[11px] font-medium text-primary">
                        Updating existing route policy
                      </span>
                    )}
                  </div>
                  <select
                    id="policy-route-select"
                    value={selectedRouteId}
                    onChange={e => handleRouteSelectionChange(e.target.value)}
                    className="w-full rounded-xl bg-zinc-50 dark:bg-[#0b0d14] border border-zinc-300 dark:border-white/20 px-3.5 py-2.5 text-xs sm:text-sm font-mono text-zinc-900 dark:text-zinc-100 focus:outline-none focus:border-primary transition-colors"
                    required
                  >
                    <option value="">Select a gateway route...</option>
                    {routes.map(r => {
                      const hasExisting = policyByRouteId.has(r.id);
                      return (
                        <option key={r.id} value={r.id}>
                          {r.pathPattern} — {r.targetUrl}{hasExisting ? ' (has policy)' : ''}
                        </option>
                      );
                    })}
                  </select>
                </div>

                {/* Calibrated Policy Presets */}
                <div>
                  <label className="block text-xs font-semibold text-zinc-800 dark:text-zinc-200 mb-2">
                    Quick Calibration Presets
                  </label>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <button
                      type="button"
                      onClick={() => applyPreset('strict')}
                      className="px-3 py-2 rounded-xl border border-zinc-300 dark:border-white/15 bg-zinc-50 dark:bg-[#0b0d14] hover:border-primary/60 text-left transition-colors"
                    >
                      <div className="text-xs font-semibold text-zinc-900 dark:text-white">Strict</div>
                      <div className="text-[11px] font-mono text-zinc-500 dark:text-zinc-400 tabular-nums mt-0.5">30 RPM · Full</div>
                    </button>
                    <button
                      type="button"
                      onClick={() => applyPreset('balanced')}
                      className="px-3 py-2 rounded-xl border border-zinc-300 dark:border-white/15 bg-zinc-50 dark:bg-[#0b0d14] hover:border-primary/60 text-left transition-colors"
                    >
                      <div className="text-xs font-semibold text-zinc-900 dark:text-white">Balanced</div>
                      <div className="text-[11px] font-mono text-zinc-500 dark:text-zinc-400 tabular-nums mt-0.5">60 RPM · Full</div>
                    </button>
                    <button
                      type="button"
                      onClick={() => applyPreset('high_throughput')}
                      className="px-3 py-2 rounded-xl border border-zinc-300 dark:border-white/15 bg-zinc-50 dark:bg-[#0b0d14] hover:border-primary/60 text-left transition-colors"
                    >
                      <div className="text-xs font-semibold text-zinc-900 dark:text-white">High Scale</div>
                      <div className="text-[11px] font-mono text-zinc-500 dark:text-zinc-400 tabular-nums mt-0.5">300 RPM · WAF</div>
                    </button>
                    <button
                      type="button"
                      onClick={() => applyPreset('ssrf_waf_only')}
                      className="px-3 py-2 rounded-xl border border-zinc-300 dark:border-white/15 bg-zinc-50 dark:bg-[#0b0d14] hover:border-primary/60 text-left transition-colors"
                    >
                      <div className="text-xs font-semibold text-zinc-900 dark:text-white">Shield Only</div>
                      <div className="text-[11px] font-mono text-zinc-500 dark:text-zinc-400 mt-0.5">Baseline RPM</div>
                    </button>
                  </div>
                </div>

                {/* Token-Bucket Rate Limit Configuration */}
                <div className="rounded-xl border border-zinc-200 dark:border-white/15 bg-zinc-50/70 dark:bg-[#0b0d14] p-4 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-2.5">
                      <Gauge size={16} className="text-primary shrink-0 mt-0.5" />
                      <div>
                        <div className="text-xs font-semibold text-zinc-950 dark:text-white">
                          Route-Specific Rate Limit Override
                        </div>
                        <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                          Enforce an isolated Redis Lua token-bucket capacity per API key or client IP on this route.
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={useCustomRpm}
                      onClick={() => setUseCustomRpm(prev => !prev)}
                      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                        useCustomRpm ? 'bg-primary' : 'bg-zinc-300 dark:bg-zinc-700'
                      }`}
                    >
                      <span
                        className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                          useCustomRpm ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>

                  {useCustomRpm ? (
                    <div className="pt-1 space-y-2.5">
                      <div className="flex items-center gap-3">
                        <input
                          id="policy-rpm-input"
                          type="number"
                          min={1}
                          max={100000}
                          value={rpmInput}
                          onChange={e => setRpmInput(e.target.value)}
                          className="w-40 rounded-xl bg-white dark:bg-[#141722] border border-zinc-300 dark:border-white/20 px-3.5 py-2 text-sm font-mono tabular-nums text-zinc-950 dark:text-white focus:outline-none focus:border-primary transition-colors"
                          required={useCustomRpm}
                        />
                        <span className="text-xs font-mono text-zinc-500 dark:text-zinc-400">
                          requests / minute (60s refill window)
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {[20, 60, 120, 300, 1000].map(val => (
                          <button
                            key={val}
                            type="button"
                            onClick={() => setRpmInput(String(val))}
                            className={`px-2.5 py-1 rounded-lg text-xs font-mono tabular-nums border transition-colors ${
                              rpmInput === String(val)
                                ? 'border-primary bg-primary/15 text-primary font-semibold'
                                : 'border-zinc-300 dark:border-white/12 bg-white dark:bg-[#141722] text-zinc-600 dark:text-zinc-300 hover:border-zinc-400 dark:hover:border-white/25'
                            }`}
                          >
                            {val} RPM
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="text-xs text-zinc-500 dark:text-zinc-400 font-mono tabular-nums">
                      Inheriting project baseline limit ({baseline.defaultRpm} RPM · {baseline.failureMode}).
                    </div>
                  )}
                </div>

                {/* WAF Inspection Toggle */}
                <div className="rounded-xl border border-zinc-200 dark:border-white/15 bg-zinc-50/70 dark:bg-[#0b0d14] p-4 flex items-start justify-between gap-3">
                  <div className="flex items-start gap-2.5">
                    <ShieldCheck size={16} className="text-emerald-500 dark:text-emerald-400 shrink-0 mt-0.5" />
                    <div>
                      <div className="text-xs font-semibold text-zinc-950 dark:text-white">
                        Active WAF Threat Blocking
                      </div>
                      <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 leading-relaxed">
                        Block SQL injection, cross-site scripting (XSS), and path traversal signatures with HTTP 403. When turned off, threats are logged in monitor-only mode.
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={enableWaf}
                    onClick={() => setEnableWaf(prev => !prev)}
                    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                      enableWaf ? 'bg-primary' : 'bg-zinc-300 dark:bg-zinc-700'
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                        enableWaf ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>

                {/* Deep Parameter SSRF Guard Toggle */}
                <div className="rounded-xl border border-zinc-200 dark:border-white/15 bg-zinc-50/70 dark:bg-[#0b0d14] p-4 flex items-start justify-between gap-3">
                  <div className="flex items-start gap-2.5">
                    <Lock size={16} className="text-sky-500 dark:text-sky-400 shrink-0 mt-0.5" />
                    <div>
                      <div className="text-xs font-semibold text-zinc-950 dark:text-white">
                        Deep Parameter SSRF Inspection
                      </div>
                      <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 leading-relaxed">
                        Scan inbound query and JSON body URL parameters (<code className="font-mono">url</code>, <code className="font-mono">target</code>, <code className="font-mono">redirect</code>, <code className="font-mono">webhook</code>) and block private IPv4/IPv6, loopback, and cloud metadata targets.
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={enableSsrf}
                    onClick={() => setEnableSsrf(prev => !prev)}
                    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                      enableSsrf ? 'bg-primary' : 'bg-zinc-300 dark:bg-zinc-700'
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                        enableSsrf ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>
              </div>

              {/* Modal Footer */}
              <div className="px-6 py-4 border-t border-zinc-200 dark:border-white/12 bg-zinc-50 dark:bg-[#10131c] flex items-center justify-end gap-3 shrink-0">
                <button
                  type="button"
                  onClick={() => setIsComposerOpen(false)}
                  className="px-4 py-2 rounded-xl text-xs font-medium text-zinc-600 dark:text-zinc-300 hover:text-zinc-950 dark:hover:text-white hover:bg-zinc-200/60 dark:hover:bg-white/10 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSaving || !selectedRouteId}
                  className="px-5 py-2 rounded-xl bg-primary hover:bg-primary-hover disabled:opacity-50 text-zinc-950 text-xs font-semibold transition-colors shadow-sm whitespace-nowrap"
                >
                  {isSaving ? 'Saving Policy...' : isEditingExisting ? 'Update Route Policy' : 'Save Route Policy'}
                </button>
              </div>
            </form>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
