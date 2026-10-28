import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useProject, Project } from '../context/ProjectContext.js';
import { ChevronDown, Check, Plus, FolderKanban, Layers, ShieldCheck, Zap, ExternalLink, Sparkles, X, Search } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

function getEnvironmentMeta(env: string) {
  switch (env?.toLowerCase()) {
    case 'production':
      return {
        label: 'PROD',
        textClass: 'text-emerald-600 dark:text-emerald-400'
      };
    case 'staging':
      return {
        label: 'STAGE',
        textClass: 'text-amber-600 dark:text-amber-400'
      };
    default:
      return {
        label: 'DEV',
        textClass: 'text-sky-600 dark:text-sky-400'
      };
  }
}

export function ProjectSwitcher() {
  const { projects, currentProject, switchProject, createProject, isLoading } = useProject();
  const [isOpen, setIsOpen] = useState(false);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [searchFilter, setSearchFilter] = useState('');
  const navigate = useNavigate();

  // Create Project form states
  const [newProjectName, setNewProjectName] = useState('');
  const [newEnvironment, setNewEnvironment] = useState<'development' | 'staging' | 'production'>('development');
  const [newPreset, setNewPreset] = useState<'strict' | 'balanced' | 'permissive'>('balanced');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [createError, setCreateError] = useState('');

  // Close overlays on Escape key
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (isCreateModalOpen) {
          setIsCreateModalOpen(false);
        } else if (isOpen) {
          setIsOpen(false);
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, isCreateModalOpen]);

  const handleSelect = (project: Project) => {
    switchProject(project.id);
    setIsOpen(false);
    setSearchFilter('');
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

  const activeEnv = getEnvironmentMeta(currentProject?.environment || 'development');

  return (
    <div className="relative min-w-0 max-w-[180px] sm:max-w-[220px] md:max-w-[260px] lg:max-w-[280px]">
      {/* Trigger Button — Solid Night Mode surface that stands distinct from header & canvas */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        className={`flex items-center gap-2 sm:gap-2.5 px-2.5 sm:px-3 py-1.5 rounded-xl border transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 text-left w-full min-w-0 shadow-md ${
          isOpen
            ? 'bg-zinc-100 dark:bg-[#1c2030] border-primary text-zinc-950 dark:text-white'
            : 'bg-white dark:bg-[#151824] hover:bg-zinc-50 dark:hover:bg-[#1c2030] border-zinc-300 dark:border-white/20 hover:border-primary/60 text-zinc-900 dark:text-zinc-100'
        }`}
        title="Switch active API project"
      >
        <div className="flex items-center justify-center w-6 h-6 rounded-lg bg-zinc-100 dark:bg-[#0d1018] border border-zinc-200 dark:border-white/15 text-primary shrink-0">
          <FolderKanban size={13} />
        </div>
        <div className="flex flex-col min-w-0 flex-1">
          <div className="flex items-center gap-1.5 leading-none">
            <span className="text-[10px] font-semibold text-zinc-500 dark:text-zinc-400 tracking-wide">Project</span>
            <span className="text-zinc-400 dark:text-zinc-600 text-[10px]" aria-hidden="true">·</span>
            <span className={`text-[10px] font-mono font-semibold ${activeEnv.textClass}`}>
              {activeEnv.label}
            </span>
          </div>
          <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100 truncate mt-0.5 block">
            {isLoading ? 'Loading...' : currentProject ? currentProject.name : 'Select Project'}
          </span>
        </div>
        <ChevronDown
          size={14}
          className={`text-zinc-500 dark:text-zinc-400 transition-transform duration-150 shrink-0 ${isOpen ? 'rotate-180 text-primary' : ''}`}
        />
      </button>

      {/* Full-Screen Blurred Overlay for Project Switcher (Portaled to document.body to escape header backdrop-filter) */}
      {isOpen && typeof document !== 'undefined' && createPortal(
        <div
          className="fixed inset-0 z-[9998] flex items-start sm:items-center justify-center p-4 pt-16 sm:pt-4 bg-black/70 backdrop-blur-md"
          onClick={() => setIsOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Switch API Project"
        >
          <div
            className="w-full max-w-md rounded-2xl bg-white dark:bg-[#141722] border border-zinc-200 dark:border-white/15 shadow-2xl overflow-hidden text-zinc-900 dark:text-zinc-100"
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="px-5 py-4 flex items-center justify-between border-b border-zinc-200 dark:border-white/12 bg-zinc-50 dark:bg-[#10131c]">
              <div>
                <h3 className="text-sm font-semibold text-zinc-950 dark:text-white flex items-center gap-2">
                  <FolderKanban size={16} className="text-primary shrink-0" />
                  <span>API Workspace Projects</span>
                </h3>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 tabular-nums">
                  {projects.length} {projects.length === 1 ? 'project' : 'projects'} available · Select an isolated gateway workspace
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setIsOpen(false);
                    setIsCreateModalOpen(true);
                  }}
                  className="px-3 py-1.5 rounded-lg bg-primary hover:bg-primary-hover text-xs font-semibold text-zinc-950 flex items-center gap-1 transition-colors whitespace-nowrap shrink-0"
                >
                  <Plus size={13} /> New Project
                </button>
                <button
                  type="button"
                  onClick={() => setIsOpen(false)}
                  aria-label="Close project switcher"
                  className="p-1.5 rounded-lg text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white hover:bg-zinc-200/60 dark:hover:bg-white/10 transition-colors"
                >
                  <X size={16} />
                </button>
              </div>
            </div>

            {/* Search Filter */}
            <div className="px-5 pt-4 pb-2">
              <div className="relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400 dark:text-zinc-500 pointer-events-none" />
                <input
                  type="text"
                  placeholder="Filter projects by name or environment..."
                  value={searchFilter}
                  onChange={e => setSearchFilter(e.target.value)}
                  className="w-full bg-zinc-50 dark:bg-[#0b0d14] border border-zinc-300 dark:border-white/20 rounded-xl pl-9 pr-3 py-2 text-xs text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:border-primary transition-colors"
                  autoFocus
                />
              </div>
            </div>

            {/* Project List */}
            <div className="max-h-72 overflow-y-auto px-5 py-2 space-y-1.5">
              {filteredProjects.length === 0 ? (
                <div className="py-8 text-center text-xs text-zinc-500 dark:text-zinc-400">
                  No matching projects found.
                </div>
              ) : (
                filteredProjects.map(proj => {
                  const isSelected = currentProject?.id === proj.id;
                  const env = getEnvironmentMeta(proj.environment);

                  return (
                    <button
                      type="button"
                      key={proj.id}
                      onClick={() => handleSelect(proj)}
                      className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl border transition-colors text-left ${
                        isSelected
                          ? 'bg-primary/15 border-primary/40 text-zinc-950 dark:text-white'
                          : 'bg-zinc-50/70 dark:bg-[#0e111a] hover:bg-zinc-100 dark:hover:bg-[#191d2b] border-zinc-200/80 dark:border-white/10 text-zinc-800 dark:text-zinc-200'
                      }`}
                    >
                      <div className="min-w-0 flex-1 pr-3">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={`text-sm truncate ${isSelected ? 'font-semibold text-primary' : 'font-medium'}`}>
                            {proj.name}
                          </span>
                          <span className="text-zinc-400 dark:text-zinc-600 text-xs shrink-0" aria-hidden="true">·</span>
                          <span className={`text-[11px] font-mono font-semibold shrink-0 ${env.textClass}`}>
                            {env.label}
                          </span>
                        </div>
                        <div className="text-xs text-zinc-500 dark:text-zinc-400 flex items-center gap-2 mt-0.5 tabular-nums">
                          <span>{proj.routeCount ?? 0} routes</span>
                          <span aria-hidden="true">·</span>
                          <span>{proj.keyCount ?? 0} keys</span>
                          {typeof proj.experimentCount === 'number' && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span>{proj.experimentCount} experiments</span>
                            </>
                          )}
                        </div>
                      </div>
                      {isSelected && (
                        <Check size={16} className="text-primary shrink-0" />
                      )}
                    </button>
                  );
                })
              )}
            </div>

            {/* Footer Actions */}
            <div className="border-t border-zinc-200 dark:border-white/12 px-5 py-3 bg-zinc-50 dark:bg-[#10131c] flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => {
                  setIsOpen(false);
                  setIsCreateModalOpen(true);
                }}
                className="flex items-center gap-2 px-3 py-2 rounded-xl bg-white dark:bg-[#181c2a] hover:bg-zinc-100 dark:hover:bg-[#202638] border border-zinc-300 dark:border-white/15 text-xs font-semibold text-zinc-900 dark:text-zinc-100 transition-colors whitespace-nowrap"
              >
                <Plus size={14} className="text-primary" />
                <span>Create New Project</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsOpen(false);
                  navigate('/settings?tab=projects');
                }}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl hover:bg-zinc-200/60 dark:hover:bg-white/10 text-xs font-medium text-zinc-600 dark:text-zinc-300 hover:text-zinc-950 dark:hover:text-white transition-colors whitespace-nowrap"
              >
                <Layers size={14} />
                <span>Manage All Projects</span>
                <ExternalLink size={12} className="opacity-75" />
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Full-Screen Blurred Create Project Modal (Portaled to document.body) */}
      {isCreateModalOpen && typeof document !== 'undefined' && createPortal(
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/75 backdrop-blur-md"
          onClick={() => setIsCreateModalOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Create New API Project"
        >
          <div
            className="w-full max-w-lg max-h-[88vh] flex flex-col rounded-2xl bg-white dark:bg-[#141722] border border-zinc-200 dark:border-white/15 shadow-2xl overflow-hidden text-zinc-900 dark:text-zinc-100"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-200 dark:border-white/12 bg-zinc-50 dark:bg-[#10131c] shrink-0">
              <div>
                <h3 className="text-base font-semibold text-zinc-950 dark:text-white flex items-center gap-2">
                  <FolderKanban size={18} className="text-primary" />
                  <span>Create New API Project</span>
                </h3>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                  Provision an isolated gateway workspace with dedicated routes, keys, and policies.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsCreateModalOpen(false)}
                aria-label="Close modal"
                className="text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white p-1.5 rounded-lg hover:bg-zinc-200/60 dark:hover:bg-white/10 transition-colors"
              >
                <X size={16} />
              </button>
            </div>

            {createError && (
              <div className="mx-6 mt-4 p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-600 dark:text-red-400 text-xs font-medium shrink-0">
                {createError}
              </div>
            )}

            <form onSubmit={handleCreateSubmit} className="flex flex-col flex-1 min-h-0 overflow-hidden">
              <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
                <div>
                  <label htmlFor="new-project-name" className="block text-xs font-semibold text-zinc-800 dark:text-zinc-200 mb-1.5">
                    Project Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    id="new-project-name"
                    type="text"
                    placeholder="e.g. Payments Gateway, Auth Service v2"
                    value={newProjectName}
                    onChange={e => setNewProjectName(e.target.value)}
                    className="w-full bg-zinc-50 dark:bg-[#0b0d14] border border-zinc-300 dark:border-white/20 rounded-xl px-3.5 py-2.5 text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:border-primary transition-colors"
                    required
                    autoFocus
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-zinc-800 dark:text-zinc-200 mb-1.5">
                    Target Environment
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    {(['development', 'staging', 'production'] as const).map(env => (
                      <button
                        type="button"
                        key={env}
                        onClick={() => setNewEnvironment(env)}
                        className={`px-3 py-2 rounded-xl text-xs font-semibold border text-center transition-colors capitalize whitespace-nowrap ${
                          newEnvironment === env
                            ? 'border-primary bg-primary/15 text-primary'
                            : 'border-zinc-300 dark:border-white/15 bg-zinc-50 dark:bg-[#0b0d14] text-zinc-600 dark:text-zinc-300 hover:text-zinc-950 dark:hover:text-white'
                        }`}
                      >
                        {env}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-zinc-800 dark:text-zinc-200 mb-1.5">
                    Initial Security & Rate Policy Preset
                  </label>
                  <div className="space-y-2">
                    {[
                      {
                        id: 'strict',
                        name: 'Strict Shield (Enterprise)',
                        desc: '30 RPM, 3000ms timeout, WAF enabled, strict fail-closed rate limits.',
                        icon: ShieldCheck,
                        color: 'text-emerald-500 dark:text-emerald-400'
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
                        color: 'text-amber-500 dark:text-amber-400'
                      }
                    ].map(preset => {
                      const Icon = preset.icon;
                      const isSelected = newPreset === preset.id;
                      return (
                        <button
                          type="button"
                          key={preset.id}
                          onClick={() => setNewPreset(preset.id as 'strict' | 'balanced' | 'permissive')}
                          className={`w-full p-3.5 rounded-xl border text-left transition-colors flex items-start gap-3 ${
                            isSelected
                              ? 'border-primary bg-primary/15'
                              : 'border-zinc-200 dark:border-white/12 bg-zinc-50 dark:bg-[#0b0d14] hover:border-zinc-300 dark:hover:border-white/25'
                          }`}
                        >
                          <div className={`p-1.5 rounded-lg bg-white dark:bg-[#141722] border border-zinc-200 dark:border-white/15 ${preset.color} shrink-0 mt-0.5`}>
                            <Icon size={15} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-xs font-semibold text-zinc-950 dark:text-white flex items-center justify-between gap-2">
                              <span>{preset.name}</span>
                              {isSelected && <span className="text-[11px] font-semibold text-primary shrink-0">Selected</span>}
                            </div>
                            <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 leading-relaxed">
                              {preset.desc}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-zinc-200 dark:border-white/12 bg-zinc-50 dark:bg-[#10131c] shrink-0">
                <button
                  type="button"
                  onClick={() => setIsCreateModalOpen(false)}
                  className="px-4 py-2 rounded-xl text-xs font-medium text-zinc-600 dark:text-zinc-300 hover:text-zinc-950 dark:hover:text-white hover:bg-zinc-200/60 dark:hover:bg-white/10 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting || !newProjectName.trim()}
                  className="px-4 py-2 rounded-xl text-xs font-semibold bg-primary hover:bg-primary-hover text-zinc-950 disabled:opacity-50 transition-colors flex items-center gap-1.5 shadow-sm whitespace-nowrap"
                >
                  {isSubmitting ? 'Creating Project...' : 'Create & Activate'}
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
