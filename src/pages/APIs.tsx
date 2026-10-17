import { fetchWithAuth } from "../lib/api.js";
import React, { useEffect, useState } from 'react';
import { Card } from '../components/ui/card.js';
import { useOutletContext } from 'react-router-dom';
import { useProject } from '../context/ProjectContext.js';

export default function APIs() {
  const { currentProject } = useProject();
  const [routes, setRoutes] = useState<any[]>([]);
  const [keys, setKeys] = useState<any[]>([]);
  const outletContext = useOutletContext<{ searchQuery?: string }>() || {};
  const searchQuery = outletContext.searchQuery || '';
  
  const [isAddingRoute, setIsAddingRoute] = useState(false);
  const [newRoute, setNewRoute] = useState({ path: '/api/', targetUrl: 'https://', authRequired: true });
  
  const [isAddingKey, setIsAddingKey] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [generatedKey, setGeneratedKey] = useState<string | null>(null);

  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const projectId = currentProject?.id || localStorage.getItem('fortix_project_id') || '';

  const fetchData = () => {
    fetchWithAuth(`/api/control/routes?projectId=${projectId}`)
      .then(r => r.ok ? r.json() : [])
      .then(data => setRoutes(Array.isArray(data) ? data : []))
      .catch(() => setRoutes([]));
    fetchWithAuth(`/api/control/keys?projectId=${projectId}`)
      .then(r => r.ok ? r.json() : [])
      .then(data => setKeys(Array.isArray(data) ? data : []))
      .catch(() => setKeys([]));
  };

  useEffect(() => {
    fetchData();
  }, [projectId]);

  const createRoute = async () => {
    setErrorMsg('');
    setLoading(true);
    try {
      const res = await fetchWithAuth('/api/control/routes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          pathPattern: newRoute.path,
          targetUrl: newRoute.targetUrl
        })
      });
      if (res.ok) {
        setIsAddingRoute(false);
        setNewRoute({ path: '/api/', targetUrl: 'https://', authRequired: true });
        fetchData();
      } else {
        const err = await res.json();
        setErrorMsg(err.error || 'Failed to create route');
      }
    } catch (err) {
      setErrorMsg('Failed to create route');
    }
    setLoading(false);
  };

  const deleteRoute = async (id: string) => {
    if (!confirm('Are you sure you want to delete this route?')) return;
    await fetchWithAuth(`/api/control/routes/${id}?projectId=${projectId}`, { method: 'DELETE' });
    fetchData();
  };

  const createKey = async () => {
    setErrorMsg('');
    setLoading(true);
    try {
      const res = await fetchWithAuth('/api/control/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, name: newKeyName || 'FortiX API Key' })
      });
      if (res.ok) {
        const data = await res.json();
        setGeneratedKey(data.rawKey);
        setIsAddingKey(false);
        setNewKeyName('');
        fetchData();
      } else {
        const err = await res.json();
        setErrorMsg(err.error || 'Failed to create key');
      }
    } catch (err) {
      setErrorMsg('Failed to create key');
    }
    setLoading(false);
  };

  const revokeKey = async (id: string) => {
    if (!confirm('Are you sure you want to revoke this key? Traffic will be blocked instantly.')) return;
    await fetchWithAuth(`/api/control/keys/${id}/revoke`, { 
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId })
    });
    fetchData();
  };

  const getStatus = (id: string) => {
    if (id === 'route-1') return 'Under Test';
    return 'Active';
  };

  const filteredRoutes = (Array.isArray(routes) ? routes : []).filter(r => {
    if (!r) return false;
    const status = getStatus(r.id);
    const q = (searchQuery || '').toLowerCase();
    const routePath = (r.pathPattern || r.path || '').toLowerCase();
    const routeStatus = (status || '').toLowerCase();
    const routeTarget = (r.targetUrl || '').toLowerCase();
    return routePath.includes(q) || routeStatus.includes(q) || routeTarget.includes(q);
  });

  return (
    <div className="space-y-8">
      {errorMsg && (
        <div className="bg-red-500/20 text-red-400 p-4 rounded border border-red-500/30">
          {errorMsg}
        </div>
      )}

      {/* Routes Section */}
      <div>
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-3xl font-bold tracking-tight text-strong">Protected APIs</h2>
          <button 
            onClick={() => setIsAddingRoute(!isAddingRoute)} 
            className="px-4 py-2 bg-hover border border-subtle text-strong rounded text-sm font-bold tracking-widest uppercase hover:bg-border transition"
          >
            {isAddingRoute ? 'Cancel' : 'Add API Route'}
          </button>
        </div>

        {isAddingRoute && (
          <Card className="p-6 mb-6 bg-card border-subtle">
            <h3 className="text-lg font-bold text-strong mb-4">Register New Upstream Route</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <div className="flex flex-col gap-2">
                <label className="text-[10px] font-bold uppercase tracking-widest text-muted">Path Segment</label>
                <input 
                  type="text" 
                  value={newRoute.path}
                  onChange={e => setNewRoute({...newRoute, path: e.target.value})}
                  className="bg-base border border-subtle text-strong text-sm rounded px-3 py-2 outline-none focus:border-primary"
                  placeholder="/api/v1/resource"
                />
              </div>
              <div className="flex flex-col gap-2">
                <label className="text-[10px] font-bold uppercase tracking-widest text-muted">Target URL</label>
                <input 
                  type="text" 
                  value={newRoute.targetUrl}
                  onChange={e => setNewRoute({...newRoute, targetUrl: e.target.value})}
                  className="bg-base border border-subtle text-strong text-sm rounded px-3 py-2 outline-none focus:border-primary"
                  placeholder="https://backend.internal"
                />
              </div>
            </div>
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 cursor-pointer">
                <input 
                  type="checkbox" 
                  checked={newRoute.authRequired}
                  onChange={e => setNewRoute({...newRoute, authRequired: e.target.checked})}
                  className="accent-[#F27D26] w-4 h-4 cursor-pointer"
                />
                <span className="text-sm font-medium text-strong">Require Authentication</span>
              </label>
              <button 
                onClick={createRoute}
                disabled={loading}
                className="px-6 py-2 bg-primary text-inverted rounded text-sm font-bold tracking-widest uppercase hover:bg-orange-500 transition disabled:opacity-50"
              >
                {loading ? 'Saving...' : 'Save Route'}
              </button>
            </div>
          </Card>
        )}

        <div className="grid gap-4">
          {filteredRoutes.map(r => {
            const status = getStatus(r.id);
            return (
              <Card key={r.id} className="p-6 flex flex-col md:flex-row justify-between items-start md:items-center bg-card border-subtle">
                <div>
                  <p className="font-medium text-lg text-strong">{r.pathPattern || r.path || '—'}</p>
                  <p className="text-sm text-muted mt-1">Targets: {r.targetUrl || '—'}</p>
                </div>
                <div className="flex flex-wrap items-center gap-4 mt-4 md:mt-0">
                  <div className={`text-xs px-3 py-1 border rounded font-bold tracking-widest uppercase ${
                    status === 'Under Test' ? 'bg-primary/20 text-primary border-primary/30 animate-pulse' :
                    'bg-green-500/20 text-green-400 border-green-500/30'
                  }`}>
                    {status}
                  </div>
                  <div className="text-xs px-3 py-1 bg-hover border border-subtle rounded text-base-text font-bold tracking-widest uppercase">
                    {r.authRequired ? 'Auth Required' : 'Public'}
                  </div>
                  <button onClick={() => deleteRoute(r.id)} className="text-xs text-red-500 hover:text-red-400 uppercase font-bold tracking-widest">
                    Delete
                  </button>
                </div>
              </Card>
            );
          })}
          {filteredRoutes.length === 0 && <p className="text-muted text-sm">No routes found matching your search.</p>}
        </div>
      </div>

      {/* Keys Section */}
      <div>
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-3xl font-bold tracking-tight text-strong">API Keys</h2>
          <button 
            onClick={() => setIsAddingKey(!isAddingKey)} 
            className="px-4 py-2 bg-primary text-inverted rounded text-sm font-bold tracking-widest uppercase hover:bg-orange-500 transition"
          >
            {isAddingKey ? 'Cancel' : 'Generate Key'}
          </button>
        </div>

        {isAddingKey && (
          <Card className="p-6 mb-6 bg-card border-subtle">
            <h3 className="text-lg font-bold text-strong mb-4">Create New API Key</h3>
            <div className="flex flex-col gap-2 mb-4">
              <label className="text-[10px] font-bold uppercase tracking-widest text-muted">Key Name (Internal)</label>
              <input 
                type="text" 
                value={newKeyName}
                onChange={e => setNewKeyName(e.target.value)}
                className="bg-base border border-subtle text-strong text-sm rounded px-3 py-2 outline-none focus:border-primary"
                placeholder="e.g. Production Billing App"
              />
            </div>
            <div className="flex justify-end">
              <button 
                onClick={createKey}
                disabled={loading || !newKeyName.trim()}
                className="px-6 py-2 bg-primary text-inverted rounded text-sm font-bold tracking-widest uppercase hover:bg-orange-500 transition disabled:opacity-50"
              >
                {loading ? 'Generating...' : 'Create Secret Key'}
              </button>
            </div>
          </Card>
        )}

        {generatedKey && (
          <Card className="p-6 mb-6 bg-green-900/20 border-green-500/50">
            <h3 className="text-lg font-bold text-green-400 mb-2">Key Generated Successfully</h3>
            <p className="text-sm text-green-300 mb-4">Please copy this secret key now. You will not be able to see it again.</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 bg-black/50 border border-green-500/30 p-3 rounded text-green-400 font-mono text-sm break-all">
                {generatedKey}
              </code>
              <button 
                onClick={() => { navigator.clipboard.writeText(generatedKey); alert('Copied!'); setGeneratedKey(null); }}
                className="px-4 py-3 bg-green-600 hover:bg-green-500 text-strong rounded font-bold uppercase text-xs tracking-widest transition"
              >
                Copy & Close
              </button>
            </div>
          </Card>
        )}

        <div className="grid gap-4">
          {keys.map(k => (
            <Card key={k.id} className={`p-4 flex flex-col md:flex-row justify-between items-start md:items-center bg-card border-subtle ${k.revoked ? 'opacity-50' : ''}`}>
              <div>
                <p className="font-medium text-strong flex items-center gap-2">
                  {k.name}
                  <span className="text-muted text-xs font-mono">{k.id.split('-')[0]}***</span>
                </p>
                <p className="text-xs text-muted mt-1">Created: {new Date(k.createdAt).toLocaleString()}</p>
              </div>
              <div className="flex items-center gap-4 mt-4 md:mt-0">
                <div className={`text-xs px-3 py-1 border rounded font-bold tracking-widest uppercase ${k.revoked ? 'bg-red-500/20 text-red-400 border-red-500/30' : 'bg-green-500/20 text-green-400 border-green-500/30'}`}>
                  {k.revoked ? 'Revoked' : 'Active'}
                </div>
                {!k.revoked && (
                  <button onClick={() => revokeKey(k.id)} className="text-xs text-red-500 hover:text-red-400 uppercase font-bold tracking-widest">
                    Revoke
                  </button>
                )}
              </div>
            </Card>
          ))}
          {keys.length === 0 && <p className="text-muted text-sm">No API keys generated.</p>}
        </div>
      </div>
    </div>
  );
}
