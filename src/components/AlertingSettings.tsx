import React, { useState, useEffect } from 'react';
import { fetchWithAuth } from '../lib/api.js';
import { Trash2, Plus, Check } from 'lucide-react';

export function AlertingSettings({ user }: { user?: any }) {
  const [webhooks, setWebhooks] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const projectId = localStorage.getItem('fortix_project_id') || '';

  const [isAdding, setIsAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [newSecret, setNewSecret] = useState('');
  const [newEvents, setNewEvents] = useState<string[]>([]);

  const availableEvents = [
    'RATE_LIMIT_EXCEEDED',
    'INVALID_API_KEY',
    'PATH_TRAVERSAL',
    'EXPERIMENT_STARTED',
    'EXPERIMENT_COMPLETED'
  ];

  const loadWebhooks = async () => {
    setIsLoading(true);
    try {
      const res = await fetchWithAuth(`/api/control/webhooks?projectId=${projectId}`);
      if (res.ok) {
        const data = await res.json();
        setWebhooks(data);
      } else {
        setError('Failed to load webhooks');
      }
    } catch (err) {
      setError('An error occurred while loading webhooks');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (projectId) loadWebhooks();
  }, [projectId]);

  const handleAddWebhook = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetchWithAuth(`/api/control/webhooks?projectId=${projectId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newName,
          url: newUrl,
          secret: newSecret,
          events: newEvents,
          isActive: true
        })
      });

      if (res.ok) {
        setNewName('');
        setNewUrl('');
        setNewSecret('');
        setNewEvents([]);
        setIsAdding(false);
        loadWebhooks();
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to add webhook');
      }
    } catch (err) {
      alert('Error adding webhook');
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this webhook?')) return;
    try {
      const res = await fetchWithAuth(`/api/control/webhooks/${id}?projectId=${projectId}`, {
        method: 'DELETE'
      });
      if (res.ok) {
        loadWebhooks();
      }
    } catch (err) {
      alert('Error deleting webhook');
    }
  };

  const handleToggle = async (id: string, currentStatus: boolean) => {
    try {
      const res = await fetchWithAuth(`/api/control/webhooks/${id}/toggle?projectId=${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !currentStatus })
      });
      if (res.ok) {
        loadWebhooks();
      }
    } catch (err) {
      alert('Error toggling webhook');
    }
  };

  const toggleEvent = (event: string) => {
    setNewEvents(prev => 
      prev.includes(event) 
        ? prev.filter(e => e !== event)
        : [...prev, event]
    );
  };

  return (
    <div className="space-y-6">
      <section className="bg-elevated border border-subtle rounded-lg overflow-hidden">
        <div className="px-6 py-4 border-b border-subtle bg-card flex justify-between items-center">
          <h3 className="font-semibold text-strong">Outgoing Webhooks</h3>
          {!isAdding && (
            <button 
              onClick={() => setIsAdding(true)}
              className="flex items-center gap-1 px-3 py-1.5 bg-primary hover:bg-primary-hover text-strong text-xs font-bold rounded transition"
            >
              <Plus size={14} /> Add Webhook
            </button>
          )}
        </div>
        <div className="p-6 space-y-4">
          {user?.role === 'VIEWER' ? (
            <div className="text-center py-8">
              <h4 className="text-lg font-bold text-strong mb-2">Operator Permission Required</h4>
              <p className="text-sm text-muted max-w-md mx-auto">
                Read-only VIEWER accounts cannot configure or modify outbound webhook notifications. Request DEVELOPER role access from your workspace administrator.
              </p>
            </div>
          ) : (
          <>
          <p className="text-xs text-muted">Configure outgoing webhooks to notify external services of specific events.</p>
          
          {error && <div className="text-red-500 text-sm">{error}</div>}
          
          {isAdding && (
            <form onSubmit={handleAddWebhook} className="bg-card border border-subtle p-4 rounded-lg space-y-4">
              <h4 className="text-sm font-bold text-strong mb-2">New Webhook</h4>
              <div>
                <label className="block text-xs font-bold text-muted uppercase tracking-widest mb-1">Name</label>
                <input required type="text" value={newName} onChange={e => setNewName(e.target.value)} placeholder="My Webhook" className="w-full bg-base border border-subtle rounded p-2 text-sm text-strong focus:border-primary focus:outline-none" />
              </div>
              <div>
                <label className="block text-xs font-bold text-muted uppercase tracking-widest mb-1">Target URL</label>
                <input required type="url" value={newUrl} onChange={e => setNewUrl(e.target.value)} placeholder="https://api.example.com/webhook" className="w-full bg-base border border-subtle rounded p-2 text-sm text-strong focus:border-primary focus:outline-none" />
              </div>
              <div>
                <label className="block text-xs font-bold text-muted uppercase tracking-widest mb-1">Secret (Optional)</label>
                <input type="text" value={newSecret} onChange={e => setNewSecret(e.target.value)} placeholder="Webhook signing secret" className="w-full bg-base border border-subtle rounded p-2 text-sm text-strong focus:border-primary focus:outline-none" />
              </div>
              <div>
                <label className="block text-xs font-bold text-muted uppercase tracking-widest mb-2">Events to send</label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {availableEvents.map(event => (
                    <label key={event} className="flex items-center gap-2 cursor-pointer text-sm text-base-text" onClick={(e) => { e.preventDefault(); toggleEvent(event); }}>
                      <div className={`w-4 h-4 rounded border flex items-center justify-center ${newEvents.includes(event) ? 'bg-primary border-primary' : 'border-strong bg-transparent'}`}>
                        {newEvents.includes(event) && <Check size={12} className="text-strong" />}
                      </div>
                      {event}
                    </label>
                  ))}
                </div>
              </div>
              <div className="flex gap-2 justify-end pt-2">
                <button type="button" onClick={() => setIsAdding(false)} className="px-4 py-2 bg-transparent text-muted hover:text-strong transition rounded text-xs font-bold uppercase tracking-widest">Cancel</button>
                <button type="submit" className="px-4 py-2 bg-primary text-strong rounded text-xs font-bold uppercase tracking-widest disabled:opacity-50" disabled={newEvents.length === 0}>Save Webhook</button>
              </div>
            </form>
          )}

          {isLoading && !isAdding ? (
            <div className="text-sm text-muted">Loading webhooks...</div>
          ) : webhooks.length > 0 ? (
            <div className="space-y-3">
              {webhooks.map(wh => (
                <div key={wh.id} className="bg-hover border border-subtle rounded-lg p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <h4 className="text-sm font-bold text-strong">{wh.name}</h4>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold uppercase tracking-widest ${wh.isActive ? 'bg-green-500/10 text-green-400' : 'bg-gray-500/10 text-gray-400'}`}>
                        {wh.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </div>
                    <div className="text-xs text-muted font-mono break-all">{wh.url}</div>
                    <div className="flex flex-wrap gap-1 mt-2">
                      {wh.events.map((ev: string) => (
                        <span key={ev} className="px-1.5 py-0.5 bg-base border border-subtle rounded text-[10px] text-base-text">{ev}</span>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <button onClick={() => handleToggle(wh.id, wh.isActive)} className="text-xs font-bold text-muted hover:text-strong transition uppercase tracking-widest">
                      {wh.isActive ? 'Disable' : 'Enable'}
                    </button>
                    <button onClick={() => handleDelete(wh.id)} className="p-2 text-muted hover:text-red-500 transition rounded-full hover:bg-red-500/10">
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : !isAdding && (
            <div className="text-sm text-muted italic bg-base p-4 rounded text-center border border-subtle">
              No webhooks configured yet.
            </div>
          )}
                  </>
          )}
        </div>
      </section>
    </div>
  );
}
