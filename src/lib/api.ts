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

  // Use relative path for same-origin requests to prevent iframe proxy/CORS issues
  const targetUrl = url.startsWith('/') ? `${urlObj.pathname}${urlObj.search}` : urlObj.toString();

  let response: Response;
  try {
    response = await fetch(targetUrl, {
      ...options,
      headers
    });
  } catch (err: any) {
    // If request failed due to transient server reload or connection blip, retry once after a short delay
    if (err?.name === 'TypeError' || String(err?.message || '').toLowerCase().includes('failed to fetch')) {
      await new Promise(resolve => setTimeout(resolve, 500));
      response = await fetch(targetUrl, {
        ...options,
        headers
      });
    } else {
      throw err;
    }
  }
  
  if (response.status === 401) {
    localStorage.removeItem('fortix_token');
    window.dispatchEvent(new CustomEvent('fortix:auth-unauthorized'));
  }
  
  return response;
}
