import React, { useState, useRef, useEffect } from 'react';
import { useProject, Project } from '../context/ProjectContext.js';
import { ChevronDown, Check, Plus, FolderKanban, Settings, Layers, ShieldCheck, Zap, Activity, ExternalLink, Sparkles } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

function getEnvironmentBadge(env: string) {
  switch (env?.toLowerCase()) {
    case 'production':
      return {
        label: 'PROD',
        badgeClass: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
      };
    case 'staging':
      return {
        label: 'STAGE',
        badgeClass: 'bg-amber-500/10 text-amber-400 border-amber-500/30'
      };
    default:
      return {
        label: 'DEV',
        badgeClass: 'bg-sky-500/10 text-sky-400 border-sky-500/30'
      };
  }
}

export function ProjectSwitcher() {
  const { projects, currentProject, switchProject, createProject, isLoading } = useProject();
  const [isOpen, setIsOpen] = useState(false);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [searchFilter, setSearchFilter] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  // Create Project form states
  const [newProjectName, setNewProjectName] = useState('');
  const [newEnvironment, setNewEnvironment] = useState<'development' | 'staging' | 'production'>('development');
  const [newPreset, setNewPreset] = useState<'strict' | 'balanced' | 'permissive'>('balanced');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [createError, setCreateError] = useState('');

  // Close dropdown on outside click or escape
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setIsOpen(false);
        setIsCreateModalOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  const handleSelect = (project: Project) => {
    switchProject(project.id);
    setIsOpen(false);
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProjectName.trim()) return;

    setIsSubmitting(true);
    setCreateError('');
    try {
      await createProject({
        name: newProjectName.trim(),
        environment: newEnvironment,
        policyPreset: newPreset
      });
      setIsCreateModalOpen(false);
      setNewProjectName('');
      setNewEnvironment('development');
      setNewPreset('balanced');
      setIsOpen(false);
    } catch (err: any) {
      setCreateError(err?.message || 'Failed to create project');
    } finally {
      setIsSubmitting(false);
    }
  };

  const filteredProjects = projects.filter(p => 
    p.name.toLowerCase().includes(searchFilter.toLowerCase()) ||
    p.environment.toLowerCase().includes(searchFilter.toLowerCase())
  );

  const activeEnv = getEnvironmentBadge(currentProject?.environment || 'development');

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Trigger Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2.5 px-3 py-1.5 rounded-xl border border-subtle bg-base hover:bg-hover hover:border-primary/40 text-strong transition-all duration-150 focus:outline-none focus:ring-1 focus:ring-primary/50 text-left shrink-0 shadow-sm"
        title="Switch active API project"
      >
        <div className="flex items-center justify-center w-6 h-6 rounded-lg bg-surface border border-subtle text-primary shrink-0">
          <FolderKanban size={13} />
        </div>
        <div className="flex flex-col min-w-[100px] max-w-[180px]">
          <span className="text-[10px] uppercase font-bold text-muted tracking-wider leading-none">Project</span>
          <span className="text-xs font-semibold text-strong truncate mt-0.5">
            {isLoading ? 'Loading...' : currentProject ? currentProject.name : 'Select Project'}
          </span>
        </div>
        <span className={`text-[9px] font-mono font-bold px-1.5 py-0.5 rounded border leading-none shrink-0 ${activeEnv.badgeClass}`}>
          {activeEnv.label}
        </span>
        <ChevronDown size={14} className={`text-muted transition-transform duration-200 shrink-0 ${isOpen ? 'rotate-180 text-primary' : ''}`} />
      </button>

      {/* Popover Dropdown */}
      {isOpen && (
        <div className="absolute left-0 mt-2 w-80 rounded-2xl bg-surface border border-subtle shadow-glass p-2 z-50 backdrop-blur-xl animate-in fade-in zoom-in-95 duration-150">
          <div className="px-3 py-2 flex items-center justify-between border-b border-subtle pb-2 mb-1.5">
            <span className="text-xs font-bold uppercase tracking-wider text-muted">API Projects ({projects.length})</span>
            <button
              onClick={() => {
                setIsOpen(false);
                setIsCreateModalOpen(true);
              }}
              className="text-xs font-medium text-primary hover:text-primary-hover flex items-center gap-1 transition"
            >
              <Plus size={13} /> New Project
            </button>
          </div>

          {/* Quick Filter */}
          {projects.length > 3 && (
            <div className="px-1.5 mb-1.5">
              <input
                type="text"
                placeholder="Filter projects..."
                value={searchFilter}
                onChange={e => setSearchFilter(e.target.value)}
                className="w-full bg-base border border-subtle rounded-lg px-2.5 py-1 text-xs text-strong placeholder:text-muted focus:outline-none focus:border-primary"
                autoFocus
              />
            </div>
          )}

          {/* Project List */}
          <div className="max-h-60 overflow-y-auto space-y-1 pr-1 custom-scrollbar">
            {filteredProjects.length === 0 ? (
              <div className="p-4 text-center text-xs text-muted">
                No matching projects found.
              </div>
            ) : (
              filteredProjects.map(proj => {
                const isSelected = currentProject?.id === proj.id;
                const env = getEnvironmentBadge(proj.environment);

                return (
                  <button
                    key={proj.id}
                    onClick={() => handleSelect(proj)}
                    className={`w-full flex items-center justify-between p-2 rounded-xl transition text-left group ${
                      isSelected 
                        ? 'bg-primary/10 border border-primary/20 text-strong' 
                        : 'hover:bg-hover border border-transparent text-base-text hover:text-strong'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className={`w-2 h-2 rounded-full shrink-0 ${
                        proj.environment === 'production' ? 'bg-emerald-500' :
                        proj.environment === 'staging' ? 'bg-amber-500' : 'bg-sky-500'
                      }`} />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={`text-xs font-medium truncate ${isSelected ? 'font-bold text-primary' : ''}`}>
                            {proj.name}
                          </span>
                          <span className={`text-[9px] font-mono font-bold px-1 py-0.2 rounded border ${env.badgeClass}`}>
                            {env.label}
                          </span>
                        </div>
                        <div className="text-[10px] text-muted flex items-center gap-2 mt-0.5">
                          <span>{proj.routeCount ?? 0} routes</span>
                          <span>•</span>
                          <span>{proj.keyCount ?? 0} keys</span>
                        </div>
                      </div>
                    </div>
                    {isSelected && (
                      <Check size={14} className="text-primary shrink-0 ml-2" />
                    )}
                  </button>
                );
              })
            )}
          </div>

          {/* Bottom Actions */}
          <div className="border-t border-subtle pt-2 mt-2 flex flex-col gap-1">
            <button
              onClick={() => {
                setIsOpen(false);
                setIsCreateModalOpen(true);
              }}
              className="w-full flex items-center gap-2 px-3 py-1.5 rounded-xl hover:bg-hover text-xs font-medium text-strong transition"
            >
              <Plus size={14} className="text-primary" />
              <span>Create New Project</span>
            </button>
            <button
              onClick={() => {
                setIsOpen(false);
                navigate('/settings?tab=projects');
              }}
              className="w-full flex items-center justify-between px-3 py-1.5 rounded-xl hover:bg-hover text-xs font-medium text-muted hover:text-strong transition"
            >
              <span className="flex items-center gap-2">
                <Layers size={14} />
                <span>Manage All Projects & Policies</span>
              </span>
              <ExternalLink size={12} className="opacity-70" />
            </button>
          </div>
        </div>
      )}

      {/* Quick Create Project Modal */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="w-full max-w-lg rounded-2xl bg-surface border border-subtle shadow-2xl p-6 overflow-hidden">
            <div className="flex items-center justify-between pb-4 border-b border-subtle mb-5">
              <div>
                <h3 className="text-base font-bold text-strong flex items-center gap-2">
                  <FolderKanban size={18} className="text-primary" /> Create New API Project
                </h3>
                <p className="text-xs text-muted mt-0.5">
                  Set up a dedicated isolated gateway project with unique policies and experiments.
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
                  placeholder="e.g. Payments Gateway, Auth Service v2"
                  value={newProjectName}
                  onChange={e => setNewProjectName(e.target.value)}
                  className="w-full bg-base border border-subtle rounded-xl px-3.5 py-2 text-sm text-strong placeholder:text-muted focus:outline-none focus:border-primary transition"
                  required
                  autoFocus
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-strong mb-1.5">
                  Target Environment
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {(['development', 'staging', 'production'] as const).map(env => (
                    <button
                      type="button"
                      key={env}
                      onClick={() => setNewEnvironment(env)}
                      className={`px-3 py-2 rounded-xl text-xs font-medium border text-center transition capitalize ${
                        newEnvironment === env
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
                  Initial Security & Rate Policy Preset
                </label>
                <div className="space-y-2">
                  {[
                    {
                      id: 'strict',
                      name: 'Strict Shield (Enterprise)',
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
                    const isSelected = newPreset === preset.id;
                    return (
                      <div
                        key={preset.id}
                        onClick={() => setNewPreset(preset.id as any)}
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
                  disabled={isSubmitting || !newProjectName.trim()}
                  className="px-4 py-2 rounded-xl text-xs font-bold bg-primary text-inverted hover:opacity-90 disabled:opacity-50 transition flex items-center gap-1.5 shadow-sm"
                >
                  {isSubmitting ? 'Creating Project...' : 'Create & Activate'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
