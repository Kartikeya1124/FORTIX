import React, { useState } from 'react';
import { useProject, Project } from '../context/ProjectContext.js';
import { 
  FolderKanban, Plus, Check, ExternalLink, ShieldCheck, Zap, Sparkles, 
  Trash2, Edit3, Sliders, Globe, Shield, Activity, Copy, CheckCircle2, 
  AlertTriangle, RefreshCw, Layers, ArrowRight, Lock
} from 'lucide-react';

function getEnvBadge(env: string) {
  switch (env?.toLowerCase()) {
    case 'production':
      return {
        label: 'PRODUCTION',
        badgeClass: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
      };
    case 'staging':
      return {
        label: 'STAGING',
        badgeClass: 'bg-amber-500/10 text-amber-400 border-amber-500/30'
      };
    default:
      return {
        label: 'DEVELOPMENT',
        badgeClass: 'bg-sky-500/10 text-sky-400 border-sky-500/30'
      };
  }
}

export function ProjectManagement() {
  const { 
    projects, 
    currentProject, 
    switchProject, 
    createProject, 
    updateProject, 
    deleteProject, 
    applyPolicyPreset, 
    updateProjectPolicies, 
    refreshProjects, 
    isLoading 
  } = useProject();

  // Search and filter
  const [envFilter, setEnvFilter] = useState<'all' | 'production' | 'staging' | 'development'>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Modals state
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [policyModalProject, setPolicyModalProject] = useState<Project | null>(null);
  const [deletingProject, setDeletingProject] = useState<Project | null>(null);

  // Create Project form state
  const [createName, setCreateName] = useState('');
  const [createEnv, setCreateEnv] = useState<'development' | 'staging' | 'production'>('development');
  const [createPreset, setCreatePreset] = useState<'strict' | 'balanced' | 'permissive'>('balanced');
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [createError, setCreateError] = useState('');

  // Edit Project form state
  const [editName, setEditName] = useState('');
  const [editEnv, setEditEnv] = useState<'development' | 'staging' | 'production'>('development');
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editError, setEditError] = useState('');

  // Policy Assignment state
  const [policyTab, setPolicyTab] = useState<'presets' | 'custom'>('presets');
  const [selectedPreset, setSelectedPreset] = useState<'strict' | 'balanced' | 'permissive'>('balanced');
  const [policySubmitting, setPolicySubmitting] = useState(false);
  const [policySuccess, setPolicySuccess] = useState('');
  const [policyError, setPolicyError] = useState('');

  // Custom policy edit values
  const [customPolicies, setCustomPolicies] = useState({
    rateLimit: {
      defaultRpm: 60,
      burstMultiplier: 2,
      failureMode: 'FAIL_CLOSED' as 'FAIL_CLOSED' | 'FAIL_OPEN' | 'LOCAL_LIMIT',
      keyStrategy: 'IP_AND_KEY' as 'IP_AND_KEY' | 'API_KEY_ONLY' | 'IP_ONLY'
    },
    gateway: {
      requestTimeoutMs: 5000,
      upstreamTimeoutMs: 5000,
      maxBodyBytes: 10485760,
      enableRequestId: true
    },
    security: {
      threatDetection: true,
      ssrfProtection: true,
      enforceApiKey: true,
      securityLogging: true,
      blockSuspiciousHeaders: true
    },
    experiments: {
      enabled: true,
      maxDurationSeconds: 60,
      maxConcurrent: 2,
      maxIntensityRps: 50,
      requireAuthorization: true,
      autoCleanup: true
    }
  });

  // Delete state
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  // Open Policy Modal with project's existing configuration
  const openPolicyModal = (proj: Project) => {
    setPolicyModalProject(proj);
    setPolicyError('');
    setPolicySuccess('');
    setPolicyTab('presets');

    const s = proj.settings;
    if (s) {
      setCustomPolicies({
        rateLimit: {
          defaultRpm: s.rateLimitConfig?.defaultRpm ?? 60,
          burstMultiplier: s.rateLimitConfig?.burstMultiplier ?? 2,
          failureMode: s.rateLimitConfig?.failureMode ?? 'FAIL_CLOSED',
          keyStrategy: s.rateLimitConfig?.keyStrategy ?? 'IP_AND_KEY'
        },
        gateway: {
          requestTimeoutMs: s.gatewayConfig?.requestTimeoutMs ?? 5000,
          upstreamTimeoutMs: s.gatewayConfig?.upstreamTimeoutMs ?? 5000,
          maxBodyBytes: s.gatewayConfig?.maxBodyBytes ?? 10485760,
          enableRequestId: s.gatewayConfig?.enableRequestId ?? true
        },
        security: {
          threatDetection: s.securityConfig?.threatDetection ?? true,
          ssrfProtection: s.securityConfig?.ssrfProtection ?? true,
          enforceApiKey: s.securityConfig?.enforceApiKey ?? true,
          securityLogging: s.securityConfig?.securityLogging ?? true,
          blockSuspiciousHeaders: s.securityConfig?.blockSuspiciousHeaders ?? true
        },
        experiments: {
          enabled: s.experimentConfig?.enabled ?? true,
          maxDurationSeconds: s.experimentConfig?.maxDurationSeconds ?? 60,
          maxConcurrent: s.experimentConfig?.maxConcurrent ?? 2,
          maxIntensityRps: s.experimentConfig?.maxIntensityRps ?? 50,
          requireAuthorization: s.experimentConfig?.requireAuthorization ?? true,
          autoCleanup: s.experimentConfig?.autoCleanup ?? true
        }
      });
    }
  };

  // Handle Create Project
  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!createName.trim()) return;

    setCreateSubmitting(true);
    setCreateError('');
    try {
      await createProject({
        name: createName.trim(),
        environment: createEnv,
        policyPreset: createPreset
      });
      setIsCreateModalOpen(false);
      setCreateName('');
      setCreateEnv('development');
      setCreatePreset('balanced');
    } catch (err: any) {
      setCreateError(err.message || 'Failed to create project');
    } finally {
      setCreateSubmitting(false);
    }
  };

  // Handle Edit Project
  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingProject || !editName.trim()) return;

    setEditSubmitting(true);
    setEditError('');
    try {
      await updateProject(editingProject.id, {
        name: editName.trim(),
        environment: editEnv
      });
      setEditingProject(null);
    } catch (err: any) {
      setEditError(err.message || 'Failed to update project');
    } finally {
      setEditSubmitting(false);
    }
  };

  // Handle Apply Preset
  const handleApplyPresetSubmit = async () => {
    if (!policyModalProject) return;
    setPolicySubmitting(true);
    setPolicyError('');
    setPolicySuccess('');
    try {
      const res = await applyPolicyPreset(policyModalProject.id, selectedPreset);
      setPolicySuccess(`Policy preset '${selectedPreset}' applied (Config v${res.version})`);
      setTimeout(() => {
        setPolicyModalProject(null);
        setPolicySuccess('');
      }, 1500);
    } catch (err: any) {
      setPolicyError(err.message || 'Failed to apply policy preset');
    } finally {
      setPolicySubmitting(false);
    }
  };

  // Handle Custom Policy Submit
  const handleCustomPolicySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!policyModalProject) return;
    setPolicySubmitting(true);
    setPolicyError('');
    setPolicySuccess('');
    try {
      const res = await updateProjectPolicies(policyModalProject.id, {
        gatewayConfig: customPolicies.gateway,
        securityConfig: customPolicies.security,
        rateLimitConfig: customPolicies.rateLimit,
        experimentConfig: customPolicies.experiments
      });
      setPolicySuccess(`Custom policies saved successfully (Config v${res.version})`);
      setTimeout(() => {
        setPolicyModalProject(null);
        setPolicySuccess('');
      }, 1500);
    } catch (err: any) {
      setPolicyError(err.message || 'Failed to update project policies');
    } finally {
      setPolicySubmitting(false);
    }
  };

  // Handle Delete Project
  const handleDeleteSubmit = async () => {
    if (!deletingProject) return;
    setDeleteSubmitting(true);
    setDeleteError('');
    try {
      await deleteProject(deletingProject.id);
      setDeletingProject(null);
    } catch (err: any) {
      setDeleteError(err.message || 'Failed to delete project');
    } finally {
      setDeleteSubmitting(false);
    }
  };

  const filteredProjects = projects.filter(p => {
    const matchesEnv = envFilter === 'all' || p.environment === envFilter;
    const matchesSearch = p.name.toLowerCase().includes(searchTerm.toLowerCase()) || 
                          p.id.toLowerCase().includes(searchTerm.toLowerCase());
    return matchesEnv && matchesSearch;
  });

  const prodCount = projects.filter(p => p.environment === 'production').length;
  const stageCount = projects.filter(p => p.environment === 'staging').length;
  const devCount = projects.filter(p => p.environment === 'development').length;

  return (
    <div className="space-y-6">
      {/* Header and Controls */}
      <section className="bg-surface border border-subtle rounded-2xl p-6 space-y-6 shadow-sm">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 pb-4 border-b border-subtle">
          <div>
            <div className="flex items-center gap-2">
              <FolderKanban size={20} className="text-primary" />
              <h3 className="text-base font-bold text-strong uppercase tracking-wider">
                API Projects & Policy Governance
              </h3>
            </div>
            <p className="text-xs text-muted mt-1">
              Create, view, edit, and isolate gateway projects. Each project maintains its own configuration policies, rate limits, routes, and chaos experiments.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => refreshProjects()}
              disabled={isLoading}
              title="Refresh projects list"
              className="p-2 bg-base hover:bg-hover border border-subtle rounded-xl text-muted hover:text-strong transition"
            >
              <RefreshCw size={14} className={isLoading ? 'animate-spin text-primary' : ''} />
            </button>
            <button
              onClick={() => {
                setCreateError('');
                setCreateName('');
                setCreateEnv('development');
                setCreatePreset('balanced');
                setIsCreateModalOpen(true);
              }}
              className="flex items-center gap-2 px-4 py-2 bg-primary text-inverted rounded-xl text-xs font-bold uppercase tracking-wider shadow-sm transition hover:opacity-95"
            >
              <Plus size={15} />
              <span>Create New Project</span>
            </button>
          </div>
        </div>

        {/* Overview Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="p-4 bg-base border border-subtle rounded-xl">
            <span className="text-[10px] text-muted uppercase font-bold tracking-wider block mb-1">Total Projects</span>
            <div className="text-2xl font-mono font-bold text-strong">{projects.length}</div>
            <span className="text-[10px] text-muted mt-1 block">Active across tenant</span>
          </div>

          <div className="p-4 bg-base border border-subtle rounded-xl">
            <span className="text-[10px] text-muted uppercase font-bold tracking-wider block mb-1">Production Projects</span>
            <div className="text-2xl font-mono font-bold text-emerald-400">{prodCount}</div>
            <span className="text-[10px] text-muted mt-1 block">Strict policy enabled</span>
          </div>

          <div className="p-4 bg-base border border-subtle rounded-xl">
            <span className="text-[10px] text-muted uppercase font-bold tracking-wider block mb-1">Staging / Development</span>
            <div className="text-2xl font-mono font-bold text-sky-400">{stageCount + devCount}</div>
            <span className="text-[10px] text-muted mt-1 block">{stageCount} Stage • {devCount} Dev</span>
          </div>

          <div className="p-4 bg-base border border-subtle rounded-xl">
            <span className="text-[10px] text-muted uppercase font-bold tracking-wider block mb-1">Active Context</span>
            <div className="text-sm font-bold text-primary truncate mt-1">
              {currentProject ? currentProject.name : 'None'}
            </div>
            <span className="text-[10px] text-muted mt-1 block font-mono">
              Policy v{currentProject?.version ?? 1}
            </span>
          </div>
        </div>

        {/* Filter and Search Bar */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-2">
          <div className="flex items-center gap-1.5 p-1 bg-base border border-subtle rounded-xl w-full sm:w-auto">
            {(['all', 'production', 'staging', 'development'] as const).map(env => (
              <button
                key={env}
                onClick={() => setEnvFilter(env)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold uppercase tracking-wider transition capitalize ${
                  envFilter === env 
                    ? 'bg-surface text-primary border border-subtle shadow-xs font-bold' 
                    : 'text-muted hover:text-strong'
                }`}
              >
                {env}
              </button>
            ))}
          </div>

          <div className="w-full sm:w-64">
            <input
              type="text"
              placeholder="Search projects or IDs..."
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              className="w-full bg-base border border-subtle rounded-xl px-3 py-1.5 text-xs text-strong placeholder:text-muted focus:outline-none focus:border-primary"
            />
          </div>
        </div>
      </section>

      {/* Projects Cards List */}
      <div className="grid grid-cols-1 gap-4">
        {filteredProjects.length === 0 ? (
          <div className="p-12 text-center bg-surface border border-subtle rounded-2xl">
            <FolderKanban size={36} className="mx-auto text-muted mb-3 opacity-40" />
            <h4 className="text-sm font-bold text-strong">No Projects Found</h4>
            <p className="text-xs text-muted mt-1 max-w-sm mx-auto">
              {searchTerm || envFilter !== 'all' 
                ? 'No projects matched your search or environment filter.' 
                : 'Get started by creating your first isolated API project.'}
            </p>
          </div>
        ) : (
          filteredProjects.map(proj => {
            const isCurrent = currentProject?.id === proj.id;
            const env = getEnvBadge(proj.environment);
            const rateLimitSetting = proj.settings?.rateLimitConfig;
            const gatewaySetting = proj.settings?.gatewayConfig;
            const securitySetting = proj.settings?.securityConfig;

            return (
              <div 
                key={proj.id}
                className={`bg-surface border rounded-2xl p-6 transition-all shadow-sm ${
                  isCurrent 
                    ? 'border-primary/40 bg-gradient-to-r from-primary/[0.03] to-transparent ring-1 ring-primary/20' 
                    : 'border-subtle hover:border-border'
                }`}
              >
                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-subtle">
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <h4 className="text-base font-bold text-strong">{proj.name}</h4>
                      <span className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded-full border ${env.badgeClass}`}>
                        {env.label}
                      </span>
                      {isCurrent ? (
                        <span className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-primary/10 border border-primary/30 text-primary text-[10px] font-bold tracking-wider uppercase">
                          <CheckCircle2 size={12} /> Active Project
                        </span>
                      ) : (
                        <button
                          onClick={() => switchProject(proj.id)}
                          className="flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-base hover:bg-hover border border-subtle text-muted hover:text-primary text-[10px] font-semibold transition"
                        >
                          <ArrowRight size={11} /> Switch to this project
                        </button>
                      )}
                    </div>
                    
                    <div className="flex flex-wrap items-center gap-3 text-xs text-muted font-mono">
                      <button
                        onClick={() => copyToClipboard(proj.id, proj.id)}
                        className="flex items-center gap-1 hover:text-strong transition"
                        title="Copy Project ID"
                      >
                        <span>ID: <strong className="text-strong">{proj.id.substring(0, 13)}...</strong></span>
                        {copiedId === proj.id ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
                      </button>
                      <span>•</span>
                      <span>Created {new Date(proj.createdAt).toLocaleDateString()}</span>
                      <span>•</span>
                      <span className="text-primary font-bold">Policy v{proj.version ?? 1}</span>
                    </div>
                  </div>

                  {/* Actions Buttons */}
                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <button
                      onClick={() => openPolicyModal(proj)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-base hover:bg-hover border border-subtle hover:border-primary/40 text-xs font-semibold text-strong transition shadow-xs"
                      title="Assign or tune policies for this project"
                    >
                      <Sliders size={13} className="text-primary" />
                      <span>Policies & Presets</span>
                    </button>

                    <button
                      onClick={() => {
                        setEditingProject(proj);
                        setEditName(proj.name);
                        setEditEnv(proj.environment as any);
                        setEditError('');
                      }}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-base hover:bg-hover border border-subtle text-xs font-semibold text-strong transition shadow-xs"
                      title="Rename project or change environment"
                    >
                      <Edit3 size={13} />
                      <span>Edit</span>
                    </button>

                    <button
                      onClick={() => {
                        setDeletingProject(proj);
                        setDeleteError('');
                      }}
                      disabled={projects.length <= 1}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30 text-xs font-semibold text-rose-400 transition disabled:opacity-40 disabled:cursor-not-allowed shadow-xs"
                      title={projects.length <= 1 ? "Cannot delete the only project" : "Delete project"}
                    >
                      <Trash2 size={13} />
                      <span>Delete</span>
                    </button>
                  </div>
                </div>

                {/* Project Telemetry & Metrics Badges */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
                  <div className="p-3 bg-base border border-subtle rounded-xl flex items-center justify-between">
                    <div>
                      <span className="text-[10px] text-muted uppercase font-bold tracking-wider block">API Routes</span>
                      <span className="text-sm font-mono font-bold text-strong">{proj.routeCount ?? 0}</span>
                    </div>
                    <Globe size={16} className="text-muted opacity-50" />
                  </div>

                  <div className="p-3 bg-base border border-subtle rounded-xl flex items-center justify-between">
                    <div>
                      <span className="text-[10px] text-muted uppercase font-bold tracking-wider block">API Keys</span>
                      <span className="text-sm font-mono font-bold text-strong">{proj.keyCount ?? 0}</span>
                    </div>
                    <Lock size={16} className="text-muted opacity-50" />
                  </div>

                  <div className="p-3 bg-base border border-subtle rounded-xl flex items-center justify-between">
                    <div>
                      <span className="text-[10px] text-muted uppercase font-bold tracking-wider block">Experiments</span>
                      <span className="text-sm font-mono font-bold text-strong">{proj.experimentCount ?? 0}</span>
                    </div>
                    <Activity size={16} className="text-muted opacity-50" />
                  </div>

                  <div className="p-3 bg-base border border-subtle rounded-xl flex items-center justify-between">
                    <div>
                      <span className="text-[10px] text-muted uppercase font-bold tracking-wider block">Rate Policy</span>
                      <span className="text-xs font-mono font-bold text-strong">
                        {rateLimitSetting?.defaultRpm ?? 60} RPM
                      </span>
                    </div>
                    <Zap size={16} className="text-primary opacity-70" />
                  </div>
                </div>

                {/* Assigned Unique Policy Snapshot */}
                <div className="mt-4 pt-3 border-t border-subtle flex flex-wrap items-center justify-between gap-3 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[10px] uppercase font-bold text-muted tracking-wider">Active Policy:</span>
                    <span className="px-2 py-0.5 rounded bg-base border border-subtle text-strong font-mono text-[11px]">
                      {rateLimitSetting?.defaultRpm ?? 60} req/min ({rateLimitSetting?.failureMode ?? 'FAIL_CLOSED'})
                    </span>
                    <span className="px-2 py-0.5 rounded bg-base border border-subtle text-strong font-mono text-[11px]">
                      {gatewaySetting?.upstreamTimeoutMs ?? 5000}ms timeout
                    </span>
                    <span className={`px-2 py-0.5 rounded border text-[11px] font-mono ${
                      securitySetting?.threatDetection 
                        ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' 
                        : 'bg-base text-muted border-subtle'
                    }`}>
                      WAF {securitySetting?.threatDetection ? 'ON' : 'OFF'}
                    </span>
                    <span className={`px-2 py-0.5 rounded border text-[11px] font-mono ${
                      securitySetting?.ssrfProtection 
                        ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' 
                        : 'bg-base text-muted border-subtle'
                    }`}>
                      SSRF Guard {securitySetting?.ssrfProtection ? 'ON' : 'OFF'}
                    </span>
                  </div>

                  <button
                    onClick={() => openPolicyModal(proj)}
                    className="text-[11px] font-medium text-primary hover:text-primary-hover flex items-center gap-1 transition"
                  >
                    <span>Configure Policy</span>
                    <ArrowRight size={11} />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* MODAL 1: CREATE NEW PROJECT */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="w-full max-w-lg rounded-2xl bg-surface border border-subtle shadow-2xl p-6">
            <div className="flex items-center justify-between pb-4 border-b border-subtle mb-5">
              <div>
                <h3 className="text-base font-bold text-strong flex items-center gap-2">
                  <FolderKanban size={18} className="text-primary" /> Create New API Project
                </h3>
                <p className="text-xs text-muted mt-0.5">
                  Set up an isolated gateway project with dedicated configuration policies.
                </p>
              </div>
              <button 
                onClick={() => setIsCreateModalOpen(false)}
                className="text-muted hover:text-strong p-1 rounded-lg transition"
              >
                ✕
              </button>
            </div>

            {createError && (
              <div className="mb-4 p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-xs">
                {createError}
              </div>
            )}

            <form onSubmit={handleCreateSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-strong mb-1.5">
                  Project Name <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  placeholder="e.g. Payments Gateway v2, Mobile Core API"
                  value={createName}
                  onChange={e => setCreateName(e.target.value)}
                  className="w-full bg-base border border-subtle rounded-xl px-3.5 py-2 text-sm text-strong placeholder:text-muted focus:outline-none focus:border-primary transition"
                  required
                  autoFocus
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-strong mb-1.5">
                  Environment
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {(['development', 'staging', 'production'] as const).map(env => (
                    <button
                      type="button"
                      key={env}
                      onClick={() => setCreateEnv(env)}
                      className={`px-3 py-2 rounded-xl text-xs font-medium border text-center transition capitalize ${
                        createEnv === env
                          ? 'border-primary bg-primary/10 text-primary font-bold'
                          : 'border-subtle bg-base text-muted hover:text-strong hover:bg-hover'
                      }`}
                    >
                      {env}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-strong mb-1.5">
                  Initial Configuration Policy Preset
                </label>
                <div className="space-y-2">
                  {[
                    {
                      id: 'strict',
                      name: 'Strict Shield (Enterprise Production)',
                      desc: '30 RPM, 3000ms timeout, WAF enabled, strict fail-closed rate limits.',
                      icon: ShieldCheck,
                      color: 'text-emerald-400'
                    },
                    {
                      id: 'balanced',
                      name: 'Balanced Gateway (Recommended)',
                      desc: '60 RPM, 5000ms timeout, WAF threat detection, standard fail-closed.',
                      icon: Sparkles,
                      color: 'text-primary'
                    },
                    {
                      id: 'permissive',
                      name: 'High Throughput (Developer Sandbox)',
                      desc: '300 RPM, 10000ms timeout, threat warnings only, fail-open during faults.',
                      icon: Zap,
                      color: 'text-amber-400'
                    }
                  ].map(preset => {
                    const Icon = preset.icon;
                    const isSelected = createPreset === preset.id;
                    return (
                      <div
                        key={preset.id}
                        onClick={() => setCreatePreset(preset.id as any)}
                        className={`p-3 rounded-xl border cursor-pointer transition flex items-start gap-3 ${
                          isSelected
                            ? 'border-primary bg-primary/10 shadow-sm'
                            : 'border-subtle bg-base hover:bg-hover'
                        }`}
                      >
                        <div className={`p-1.5 rounded-lg bg-surface border border-subtle ${preset.color} shrink-0 mt-0.5`}>
                          <Icon size={15} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-semibold text-strong flex items-center justify-between">
                            <span>{preset.name}</span>
                            {isSelected && <span className="text-[10px] font-bold text-primary">Selected</span>}
                          </div>
                          <div className="text-[11px] text-muted mt-0.5 leading-relaxed">
                            {preset.desc}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-subtle mt-6">
                <button
                  type="button"
                  onClick={() => setIsCreateModalOpen(false)}
                  className="px-4 py-2 rounded-xl text-xs font-medium text-muted hover:text-strong hover:bg-hover transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={createSubmitting || !createName.trim()}
                  className="px-4 py-2 rounded-xl text-xs font-bold bg-primary text-inverted hover:opacity-90 disabled:opacity-50 transition flex items-center gap-1.5 shadow-sm"
                >
                  {createSubmitting ? 'Creating Project...' : 'Create & Activate'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 2: EDIT / RENAME PROJECT */}
      {editingProject && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="w-full max-w-md rounded-2xl bg-surface border border-subtle shadow-2xl p-6">
            <div className="flex items-center justify-between pb-4 border-b border-subtle mb-5">
              <h3 className="text-base font-bold text-strong flex items-center gap-2">
                <Edit3 size={18} className="text-primary" /> Edit Project
              </h3>
              <button 
                onClick={() => setEditingProject(null)}
                className="text-muted hover:text-strong p-1 rounded-lg transition"
              >
                ✕
              </button>
            </div>

            {editError && (
              <div className="mb-4 p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-xs">
                {editError}
              </div>
            )}

            <form onSubmit={handleEditSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-strong mb-1.5">
                  Project Name
                </label>
                <input
                  type="text"
                  value={editName}
                  onChange={e => setEditName(e.target.value)}
                  className="w-full bg-base border border-subtle rounded-xl px-3.5 py-2 text-sm text-strong focus:outline-none focus:border-primary"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-strong mb-1.5">
                  Environment
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {(['development', 'staging', 'production'] as const).map(env => (
                    <button
                      type="button"
                      key={env}
                      onClick={() => setEditEnv(env)}
                      className={`px-3 py-2 rounded-xl text-xs font-medium border text-center transition capitalize ${
                        editEnv === env
                          ? 'border-primary bg-primary/10 text-primary font-bold'
                          : 'border-subtle bg-base text-muted hover:text-strong hover:bg-hover'
                      }`}
                    >
                      {env}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-subtle mt-6">
                <button
                  type="button"
                  onClick={() => setEditingProject(null)}
                  className="px-4 py-2 rounded-xl text-xs font-medium text-muted hover:text-strong hover:bg-hover transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={editSubmitting || !editName.trim()}
                  className="px-4 py-2 rounded-xl text-xs font-bold bg-primary text-inverted hover:opacity-90 disabled:opacity-50 transition"
                >
                  {editSubmitting ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 3: ASSIGN UNIQUE CONFIGURATION POLICIES */}
      {policyModalProject && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="w-full max-w-2xl max-h-[90vh] flex flex-col rounded-2xl bg-surface border border-subtle shadow-2xl p-6 overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between pb-4 border-b border-subtle mb-4 shrink-0">
              <div>
                <h3 className="text-base font-bold text-strong flex items-center gap-2">
                  <Sliders size={18} className="text-primary" /> Assign Policies: {policyModalProject.name}
                </h3>
                <p className="text-xs text-muted mt-0.5">
                  Configure project-specific rate limits, upstream timeouts, and security barriers.
                </p>
              </div>
              <button 
                onClick={() => setPolicyModalProject(null)}
                className="text-muted hover:text-strong p-1 rounded-lg transition"
              >
                ✕
              </button>
            </div>

            {/* Notification messages */}
            {policyError && (
              <div className="mb-4 p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-xs shrink-0">
                {policyError}
              </div>
            )}
            {policySuccess && (
              <div className="mb-4 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs shrink-0 flex items-center gap-2">
                <CheckCircle2 size={14} /> {policySuccess}
              </div>
            )}

            {/* Tab selection: Presets vs Custom Tuning */}
            <div className="flex border-b border-subtle mb-4 shrink-0">
              <button
                onClick={() => setPolicyTab('presets')}
                className={`px-4 py-2 text-xs font-bold uppercase tracking-wider border-b-2 transition ${
                  policyTab === 'presets'
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted hover:text-strong'
                }`}
              >
                Quick Policy Presets
              </button>
              <button
                onClick={() => setPolicyTab('custom')}
                className={`px-4 py-2 text-xs font-bold uppercase tracking-wider border-b-2 transition ${
                  policyTab === 'custom'
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted hover:text-strong'
                }`}
              >
                Custom Policy Tuning
              </button>
            </div>

            {/* Modal Body */}
            <div className="flex-1 overflow-y-auto pr-1 space-y-4 custom-scrollbar">
              {policyTab === 'presets' ? (
                <div className="space-y-4">
                  <p className="text-xs text-muted">
                    Apply an instant calibrated policy preset to this project. This updates its rate limiting thresholds, timeouts, and WAF rules.
                  </p>

                  <div className="space-y-3">
                    {[
                      {
                        id: 'strict',
                        name: 'Strict Shield (Enterprise Production)',
                        desc: '30 RPM rate limit, 3000ms upstream abort timeout, strict fail-closed rate enforcement, full WAF payload inspection.',
                        icon: ShieldCheck,
                        color: 'text-emerald-400'
                      },
                      {
                        id: 'balanced',
                        name: 'Balanced Gateway (Standard Cloud)',
                        desc: '60 RPM rate limit, 5000ms upstream abort timeout, standard fail-closed rate enforcement, threat detection enabled.',
                        icon: Sparkles,
                        color: 'text-primary'
                      },
                      {
                        id: 'permissive',
                        name: 'High Throughput (Developer Sandbox)',
                        desc: '300 RPM rate limit, 10000ms timeout, fail-open availability mode during Redis faults, permissive developer headers.',
                        icon: Zap,
                        color: 'text-amber-400'
                      }
                    ].map(preset => {
                      const Icon = preset.icon;
                      const isSelected = selectedPreset === preset.id;
                      return (
                        <div
                          key={preset.id}
                          onClick={() => setSelectedPreset(preset.id as any)}
                          className={`p-4 rounded-xl border cursor-pointer transition flex items-start gap-3.5 ${
                            isSelected
                              ? 'border-primary bg-primary/10 shadow-sm'
                              : 'border-subtle bg-base hover:bg-hover'
                          }`}
                        >
                          <div className={`p-2 rounded-lg bg-surface border border-subtle ${preset.color} shrink-0 mt-0.5`}>
                            <Icon size={18} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-xs font-bold text-strong flex items-center justify-between">
                              <span>{preset.name}</span>
                              {isSelected && <span className="text-[10px] font-bold text-primary">Selected</span>}
                            </div>
                            <div className="text-xs text-muted mt-1 leading-relaxed">
                              {preset.desc}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <div className="pt-4 flex justify-end">
                    <button
                      onClick={handleApplyPresetSubmit}
                      disabled={policySubmitting}
                      className="px-4 py-2 bg-primary text-inverted rounded-xl text-xs font-bold uppercase tracking-wider hover:opacity-90 disabled:opacity-50 transition"
                    >
                      {policySubmitting ? 'Applying Preset...' : `Apply ${selectedPreset.toUpperCase()} Preset`}
                    </button>
                  </div>
                </div>
              ) : (
                <form onSubmit={handleCustomPolicySubmit} className="space-y-6">
                  {/* Rate Limiting Section */}
                  <div className="p-4 bg-base border border-subtle rounded-xl space-y-4">
                    <h4 className="text-xs font-bold uppercase tracking-wider text-strong flex items-center gap-2">
                      <Zap size={14} className="text-primary" /> Rate Limiting Policy
                    </h4>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-[11px] font-bold text-muted uppercase mb-1">
                          Default Requests Per Minute (RPM)
                        </label>
                        <input
                          type="number"
                          min={1}
                          max={50000}
                          value={customPolicies.rateLimit.defaultRpm}
                          onChange={e => setCustomPolicies({
                            ...customPolicies,
                            rateLimit: { ...customPolicies.rateLimit, defaultRpm: Number(e.target.value) }
                          })}
                          className="w-full bg-surface border border-subtle rounded-lg px-3 py-1.5 text-xs text-strong font-mono"
                        />
                      </div>

                      <div>
                        <label className="block text-[11px] font-bold text-muted uppercase mb-1">
                          Burst Capacity Multiplier
                        </label>
                        <input
                          type="number"
                          min={1}
                          max={10}
                          step={0.5}
                          value={customPolicies.rateLimit.burstMultiplier}
                          onChange={e => setCustomPolicies({
                            ...customPolicies,
                            rateLimit: { ...customPolicies.rateLimit, burstMultiplier: Number(e.target.value) }
                          })}
                          className="w-full bg-surface border border-subtle rounded-lg px-3 py-1.5 text-xs text-strong font-mono"
                        />
                      </div>

                      <div>
                        <label className="block text-[11px] font-bold text-muted uppercase mb-1">
                          Redis Outage Policy
                        </label>
                        <select
                          value={customPolicies.rateLimit.failureMode}
                          onChange={e => setCustomPolicies({
                            ...customPolicies,
                            rateLimit: { ...customPolicies.rateLimit, failureMode: e.target.value as any }
                          })}
                          className="w-full bg-surface border border-subtle rounded-lg px-3 py-1.5 text-xs text-strong font-mono"
                        >
                          <option value="FAIL_CLOSED">FAIL_CLOSED (Strict Security - 429)</option>
                          <option value="FAIL_OPEN">FAIL_OPEN (Availability First)</option>
                          <option value="LOCAL_LIMIT">LOCAL_LIMIT (In-Memory Fallback)</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-[11px] font-bold text-muted uppercase mb-1">
                          Key Strategy
                        </label>
                        <select
                          value={customPolicies.rateLimit.keyStrategy}
                          onChange={e => setCustomPolicies({
                            ...customPolicies,
                            rateLimit: { ...customPolicies.rateLimit, keyStrategy: e.target.value as any }
                          })}
                          className="w-full bg-surface border border-subtle rounded-lg px-3 py-1.5 text-xs text-strong font-mono"
                        >
                          <option value="IP_AND_KEY">IP_AND_KEY (Remote IP + API Key)</option>
                          <option value="API_KEY_ONLY">API_KEY_ONLY (Per-Key Global)</option>
                          <option value="IP_ONLY">IP_ONLY (Remote IP Only)</option>
                        </select>
                      </div>
                    </div>
                  </div>

                  {/* Gateway Proxy Policy */}
                  <div className="p-4 bg-base border border-subtle rounded-xl space-y-4">
                    <h4 className="text-xs font-bold uppercase tracking-wider text-strong flex items-center gap-2">
                      <Globe size={14} className="text-primary" /> Gateway & Timeout Policy
                    </h4>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-[11px] font-bold text-muted uppercase mb-1">
                          Upstream Timeout (ms)
                        </label>
                        <input
                          type="number"
                          min={500}
                          max={30000}
                          step={500}
                          value={customPolicies.gateway.upstreamTimeoutMs}
                          onChange={e => setCustomPolicies({
                            ...customPolicies,
                            gateway: { ...customPolicies.gateway, upstreamTimeoutMs: Number(e.target.value) }
                          })}
                          className="w-full bg-surface border border-subtle rounded-lg px-3 py-1.5 text-xs text-strong font-mono"
                        />
                      </div>

                      <div>
                        <label className="block text-[11px] font-bold text-muted uppercase mb-1">
                          Max Request Payload Size (Bytes)
                        </label>
                        <input
                          type="number"
                          min={1024}
                          max={52428800}
                          step={1048576}
                          value={customPolicies.gateway.maxBodyBytes}
                          onChange={e => setCustomPolicies({
                            ...customPolicies,
                            gateway: { ...customPolicies.gateway, maxBodyBytes: Number(e.target.value) }
                          })}
                          className="w-full bg-surface border border-subtle rounded-lg px-3 py-1.5 text-xs text-strong font-mono"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Security Policy */}
                  <div className="p-4 bg-base border border-subtle rounded-xl space-y-3">
                    <h4 className="text-xs font-bold uppercase tracking-wider text-strong flex items-center gap-2">
                      <Shield size={14} className="text-primary" /> Security Inspection Barriers
                    </h4>
                    
                    <label className="flex items-center gap-3 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={customPolicies.security.threatDetection}
                        onChange={e => setCustomPolicies({
                          ...customPolicies,
                          security: { ...customPolicies.security, threatDetection: e.target.checked }
                        })}
                        className="w-4 h-4 rounded text-primary border-subtle"
                      />
                      <span className="text-xs text-strong">Path Traversal & SQL Injection Payload Inspection</span>
                    </label>

                    <label className="flex items-center gap-3 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={customPolicies.security.ssrfProtection}
                        onChange={e => setCustomPolicies({
                          ...customPolicies,
                          security: { ...customPolicies.security, ssrfProtection: e.target.checked }
                        })}
                        className="w-4 h-4 rounded text-primary border-subtle"
                      />
                      <span className="text-xs text-strong">SSRF Guard (Block 127.0.0.1, internal metadata)</span>
                    </label>

                    <label className="flex items-center gap-3 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={customPolicies.security.enforceApiKey}
                        onChange={e => setCustomPolicies({
                          ...customPolicies,
                          security: { ...customPolicies.security, enforceApiKey: e.target.checked }
                        })}
                        className="w-4 h-4 rounded text-primary border-subtle"
                      />
                      <span className="text-xs text-strong">Require Valid API Key on Protected Endpoints</span>
                    </label>
                  </div>

                  <div className="pt-2 flex justify-end">
                    <button
                      type="submit"
                      disabled={policySubmitting}
                      className="px-4 py-2 bg-primary text-inverted rounded-xl text-xs font-bold uppercase tracking-wider hover:opacity-90 disabled:opacity-50 transition"
                    >
                      {policySubmitting ? 'Persisting Policies...' : 'Persist Project Policies'}
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>
        </div>
      )}

      {/* MODAL 4: DELETE PROJECT CONFIRMATION */}
      {deletingProject && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="w-full max-w-md rounded-2xl bg-surface border border-rose-500/30 shadow-2xl p-6">
            <div className="flex items-center gap-3 text-rose-500 mb-4">
              <div className="p-2.5 rounded-xl bg-rose-500/10 border border-rose-500/30">
                <AlertTriangle size={20} />
              </div>
              <div>
                <h3 className="text-base font-bold text-strong">Delete Project</h3>
                <p className="text-xs text-muted">This action is permanent and cannot be undone.</p>
              </div>
            </div>

            {deleteError && (
              <div className="mb-4 p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-xs">
                {deleteError}
              </div>
            )}

            <p className="text-xs text-muted mb-4 leading-relaxed">
              Are you sure you want to delete <strong className="text-strong">{deletingProject.name}</strong>? 
              All associated API routes ({deletingProject.routeCount ?? 0}), API keys ({deletingProject.keyCount ?? 0}), 
              experiments ({deletingProject.experimentCount ?? 0}), and configuration policies will be permanently destroyed.
            </p>

            <div className="flex items-center justify-end gap-3 pt-3 border-t border-subtle">
              <button
                type="button"
                onClick={() => setDeletingProject(null)}
                className="px-4 py-2 rounded-xl text-xs font-medium text-muted hover:text-strong hover:bg-hover transition"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteSubmit}
                disabled={deleteSubmitting}
                className="px-4 py-2 rounded-xl text-xs font-bold bg-rose-500 text-white hover:bg-rose-600 disabled:opacity-50 transition flex items-center gap-1.5"
              >
                {deleteSubmitting ? 'Deleting...' : 'Confirm & Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
