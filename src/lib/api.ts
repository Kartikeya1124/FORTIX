export function getActiveProjectId(): string | null {
  return localStorage.getItem('fortix_project_id');
}

export function setActiveProjectId(id: string): void {
  localStorage.setItem('fortix_project_id', id);
  window.dispatchEvent(new CustomEvent('fortix:project-switched', { detail: { projectId: id } }));
}

export async function fetchWithAuth(url: string, options: RequestInit = {}) {
  const token = localStorage.getItem('fortix_token');
  const projectId = getActiveProjectId();
  const headers = new Headers(options.headers || {});
  
  if (token) {
    headers.set('X-Fortix-Token', token);
  }
  
  if (projectId) {
    headers.set('X-Fortix-Project-Id', projectId);
  }
  
  const urlObj = new URL(url, window.location.origin);

  // Automatically attach projectId to control plane endpoints if not already provided
  if (projectId && url.startsWith('/api/control/') && !urlObj.searchParams.has('projectId')) {
    // Only attach to endpoints that take query parameters and aren't root listings of projects themselves
    if (!url.startsWith('/api/control/projects') || url.includes('/audit-logs')) {
      urlObj.searchParams.set('projectId', projectId);
    }
  }

  const response = await fetch(urlObj.toString(), {
    ...options,
    headers
  });
  
  if (response.status === 401) {
    localStorage.removeItem('fortix_token');
    window.location.href = '/'; // force re-login
  }
  
  return response;
}
