import { fetchWithAuth } from "../lib/api.js";
import { useEffect, useState } from "react";
import React from 'react';
import { Card } from '../components/ui/card.js';
import { useProject } from '../context/ProjectContext.js';

export default function Security() {
  const { currentProject } = useProject();
  const [policies, setPolicies] = useState<any[]>([]);
  const [routes, setRoutes] = useState<any[]>([]);
  const [isAdding, setIsAdding] = useState(false);
  
  const [newPolicy, setNewPolicy] = useState({
    routeId: '',
    type: 'RATE_LIMIT',
    maxRequests: 100,
    windowSeconds: 60
  });

  const projectId = currentProject?.id || localStorage.getItem('fortix_project_id') || '';

  const fetchData = () => {
    fetchWithAuth(`/api/control/policies?projectId=${projectId}`).then(r => r.json()).then(setPolicies).catch(() => {});
    fetchWithAuth(`/api/control/routes?projectId=${projectId}`).then(r => r.json()).then(setRoutes).catch(() => {});
  };

  useEffect(() => {
    fetchData();
  }, [projectId]);

  const createPolicy = async () => {
    if (!newPolicy.routeId) return alert('Select a route');
    const res = await fetchWithAuth('/api/control/policies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId,
        routeId: newPolicy.routeId,
        type: newPolicy.type,
        config: {
          maxRequests: newPolicy.maxRequests,
          windowSeconds: newPolicy.windowSeconds
        }
      })
    });
    if (res.ok) {
      setIsAdding(false);
      fetchData();
    } else {
      alert('Failed to save policy');
    }
  };

  const deletePolicy = async (id: string) => {
    if (!confirm('Are you sure you want to delete this policy?')) return;
    await fetchWithAuth(`/api/control/policies/${id}?projectId=${projectId}`, { method: 'DELETE' });
    fetchData();
  };

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-center">
        <h2 className="text-3xl font-bold tracking-tight text-strong">Security Policies</h2>
        <button 
          onClick={() => setIsAdding(!isAdding)} 
          className="px-4 py-2 bg-primary text-inverted rounded text-sm font-bold tracking-widest uppercase hover:bg-orange-500 transition"
        >
          {isAdding ? 'Cancel' : 'Add Policy'}
        </button>
      </div>

      {isAdding && (
        <Card className="p-6 mb-6 bg-card border-subtle">
          <h3 className="text-lg font-bold text-strong mb-4">Configure New Policy</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            <div className="flex flex-col gap-2">
              <label className="text-[10px] font-bold uppercase tracking-widest text-muted">Target Route</label>
              <select 
                value={newPolicy.routeId} 
                onChange={e => setNewPolicy({...newPolicy, routeId: e.target.value})}
                className="bg-base border border-subtle text-strong text-sm rounded px-3 py-2 outline-none focus:border-primary"
              >
                <option value="">-- Select Route --</option>
                {routes.map(r => (
                  <option key={r.id} value={r.id}>{r.path}</option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-[10px] font-bold uppercase tracking-widest text-muted">Policy Type</label>
              <select 
                value={newPolicy.type} 
                onChange={e => setNewPolicy({...newPolicy, type: e.target.value})}
                className="bg-base border border-subtle text-strong text-sm rounded px-3 py-2 outline-none focus:border-primary"
              >
                <option value="RATE_LIMIT">Rate Limit</option>
<option value="AUTH_REQUIRED">Enforce API Key Auth</option>
<option value="IP_DENYLIST">IP Denylist</option>
<option value="THREAT_DETECTION">Active Threat Inspection</option>
              </select>
            </div>
          </div>
          
          {newPolicy.type === 'RATE_LIMIT' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4 p-4 border border-subtle bg-base rounded">
              <div className="flex flex-col gap-2">
                <label className="text-[10px] font-bold uppercase tracking-widest text-muted">Max Requests</label>
                <input 
                  type="number" 
                  value={newPolicy.maxRequests}
                  onChange={e => setNewPolicy({...newPolicy, maxRequests: parseInt(e.target.value) || 0})}
                  className="bg-card border border-subtle text-strong text-sm rounded px-3 py-2 outline-none focus:border-primary"
                />
              </div>
              <div className="flex flex-col gap-2">
                <label className="text-[10px] font-bold uppercase tracking-widest text-muted">Window Seconds</label>
                <input 
                  type="number" 
                  value={newPolicy.windowSeconds}
                  onChange={e => setNewPolicy({...newPolicy, windowSeconds: parseInt(e.target.value) || 0})}
                  className="bg-card border border-subtle text-strong text-sm rounded px-3 py-2 outline-none focus:border-primary"
                />
              </div>
            </div>
          )}

          <div className="flex justify-end">
            <button 
              onClick={createPolicy}
              className="px-6 py-2 bg-primary text-inverted rounded text-sm font-bold tracking-widest uppercase hover:bg-orange-500 transition"
            >
              Save Policy
            </button>
          </div>
        </Card>
      )}

      <div className="grid gap-4">
        {policies.map(p => {
          const route = routes.find(r => r.id === p.routeId);
          return (
            <Card key={p.id} className="p-6 border-l-4 border-l-[#F27D26] bg-card border-subtle">
              <div className="flex justify-between items-start">
                <div>
                  <h3 className="font-bold text-lg text-strong">{p.type}</h3>
                  <p className="text-sm text-muted mt-1">Target Route: {route ? route.path : p.routeId}</p>
                </div>
                <div className="flex items-center gap-4">
                  <div className="text-xs px-3 py-1 bg-green-500/20 text-green-400 border border-green-500/30 rounded font-bold tracking-widest uppercase">
                    Enforced
                  </div>
                  <button onClick={() => deletePolicy(p.id)} className="text-xs text-red-500 hover:text-red-400 uppercase font-bold tracking-widest">
                    Remove
                  </button>
                </div>
              </div>
              <div className="mt-4 p-4 bg-base border border-subtle rounded-md font-mono text-sm text-muted">
                {JSON.stringify(p.config, null, 2)}
              </div>
            </Card>
          );
        })}
        {policies.length === 0 && <div className="text-muted">No policies configured.</div>}
      </div>
    </div>
  );
}
