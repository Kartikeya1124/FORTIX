import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { fetchWithAuth, getActiveProjectId, setActiveProjectId } from '../lib/api.js';

export interface Project {
  id: string;
  name: string;
  environment: 'development' | 'staging' | 'production' | string;
  orgId: string;
  createdAt: string;
  routeCount?: number;
  keyCount?: number;
  experimentCount?: number;
  version?: number;
  hasCustomSettings?: boolean;
  settings?: any;
}

interface ProjectContextValue {
  projects: Project[];
  currentProject: Project | null;
  isLoading: boolean;
  error: string | null;
  switchProject: (projectId: string) => void;
  createProject: (data: { name: string; environment: string; policyPreset?: string; description?: string }) => Promise<Project>;
  updateProject: (id: string, data: { name?: string; environment?: string }) => Promise<Project>;
  deleteProject: (id: string) => Promise<{ success: boolean; nextActiveProjectId?: string }>;
  applyPolicyPreset: (id: string, preset: 'strict' | 'balanced' | 'permissive') => Promise<any>;
  updateProjectPolicies: (id: string, policies: any) => Promise<any>;
  refreshProjects: () => Promise<void>;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

const DEFAULT_FALLBACK_PROJECT: Project = {
  id: '00000000-0000-0000-0000-000000000001',
  orgId: '00000000-0000-0000-0000-000000000001',
  name: 'Production Gateway',
  environment: 'production',
  createdAt: new Date().toISOString(),
  routeCount: 1,
  keyCount: 0,
  experimentCount: 0,
  version: 1
};

export function ProjectProvider({ children }: { children: React.ReactNode }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [currentProject, setCurrentProject] = useState<Project | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const refreshProjects = useCallback(async () => {
    try {
      const res = await fetchWithAuth('/api/control/projects');
      if (res.ok) {
        const data: Project[] = await res.json();
        setProjects(data);

        // Determine active project
        const savedId = getActiveProjectId();
        let matched = data.find(p => p.id === savedId);
        
        if (!matched && data.length > 0) {
          // If no stored project or stored project no longer exists, default to first project
          matched = data[0];
          setActiveProjectId(matched.id);
        }

        setCurrentProject(matched || null);
        setError(null);
      } else {
        setError('Failed to fetch projects');
      }
    } catch (err: any) {
      console.warn('[ProjectContext] Initial project load retry scheduled:', err?.message || err);
      setError(err?.message || 'Error loading projects');
      // If no project is currently selected, provide safe default so UI components do not throw
      setCurrentProject(prev => prev || DEFAULT_FALLBACK_PROJECT);
      // Auto-retry once in case the backend was booting
      setTimeout(async () => {
        try {
          const retryRes = await fetchWithAuth('/api/control/projects');
          if (retryRes.ok) {
            const data: Project[] = await retryRes.json();
            if (data && data.length > 0) {
              setProjects(data);
              const savedId = getActiveProjectId();
              const matched = data.find(p => p.id === savedId) || data[0];
              if (matched) {
                setActiveProjectId(matched.id);
                setCurrentProject(matched);
                setError(null);
              }
            }
          }
        } catch {
          // Keep fallback
        }
      }, 1500);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshProjects();

    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === 'fortix_project_id' && e.newValue) {
        switchProject(e.newValue);
      }
    };

    const handleCustomSwitch = (e: Event) => {
      const customEvent = e as CustomEvent<{ projectId: string }>;
      if (customEvent.detail?.projectId) {
        const target = projects.find(p => p.id === customEvent.detail.projectId);
        if (target) setCurrentProject(target);
      }
    };

    window.addEventListener('storage', handleStorageChange);
    window.addEventListener('fortix:project-switched', handleCustomSwitch);

    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener('fortix:project-switched', handleCustomSwitch);
    };
  }, [refreshProjects, projects]);

  const switchProject = useCallback((projectId: string) => {
    const target = projects.find(p => p.id === projectId);
    if (target) {
      setCurrentProject(target);
      setActiveProjectId(target.id);
    } else {
      // Refresh to ensure we have latest list
      setActiveProjectId(projectId);
      refreshProjects();
    }
  }, [projects, refreshProjects]);

  const createProject = useCallback(async (data: { name: string; environment: string; policyPreset?: string; description?: string }) => {
    const res = await fetchWithAuth('/api/control/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || 'Failed to create project');
    }

    const created: Project = await res.json();
    await refreshProjects();
    switchProject(created.id);
    return created;
  }, [refreshProjects, switchProject]);

  const updateProject = useCallback(async (id: string, data: { name?: string; environment?: string }) => {
    const res = await fetchWithAuth(`/api/control/projects/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || 'Failed to update project');
    }

    const updated: Project = await res.json();
    await refreshProjects();
    return updated;
  }, [refreshProjects]);

  const deleteProject = useCallback(async (id: string) => {
    const res = await fetchWithAuth(`/api/control/projects/${id}`, {
      method: 'DELETE'
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || 'Failed to delete project');
    }

    const result = await res.json();
    await refreshProjects();

    if (result.nextActiveProjectId) {
      switchProject(result.nextActiveProjectId);
    }

    return { success: true, nextActiveProjectId: result.nextActiveProjectId };
  }, [refreshProjects, switchProject]);

  const applyPolicyPreset = useCallback(async (id: string, preset: 'strict' | 'balanced' | 'permissive') => {
    const res = await fetchWithAuth(`/api/control/projects/${id}/policy-preset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preset })
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || 'Failed to apply policy preset');
    }

    const data = await res.json();
    await refreshProjects();
    return data;
  }, [refreshProjects]);

  const updateProjectPolicies = useCallback(async (id: string, policies: any) => {
    const res = await fetchWithAuth(`/api/control/projects/${id}/policies`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(policies)
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || 'Failed to update project policies');
    }

    const data = await res.json();
    await refreshProjects();
    return data;
  }, [refreshProjects]);

  return (
    <ProjectContext.Provider
      value={{
        projects,
        currentProject,
        isLoading,
        error,
        switchProject,
        createProject,
        updateProject,
        deleteProject,
        applyPolicyPreset,
        updateProjectPolicies,
        refreshProjects
      }}
    >
      {children}
    </ProjectContext.Provider>
  );
}

export function useProject() {
  const context = useContext(ProjectContext);
  if (!context) {
    throw new Error('useProject must be used within a ProjectProvider');
  }
  return context;
}
