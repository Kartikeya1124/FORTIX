import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Activity, Server, Shield, Play, ShieldAlert, BarChart, Settings, PanelLeft, Globe, ExternalLink } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { FORTIX_DATASET } from '../data/publicApisDataset.js';

export function CommandPalette({ isOpen, setIsOpen, toggleSidebar }: { isOpen: boolean, setIsOpen: (v: boolean) => void, toggleSidebar: () => void }) {
  const [query, setQuery] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setIsOpen(!isOpen);
      }
      if (e.key === 'Escape' && isOpen) {
        setIsOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, setIsOpen]);

  const actions = [
    { id: 'dashboard', title: 'Go to Dashboard', icon: <Activity size={16} />, onSelect: () => { navigate('/'); setIsOpen(false); } },
    { id: 'directory', title: 'Browse Public API Directory (814 APIs)', icon: <Globe size={16} />, onSelect: () => { navigate('/directory'); setIsOpen(false); } },
    { id: 'apis', title: 'Go to Protected APIs & Keys', icon: <Server size={16} />, onSelect: () => { navigate('/apis'); setIsOpen(false); } },
    { id: 'security', title: 'Go to Security Policies', icon: <Shield size={16} />, onSelect: () => { navigate('/security'); setIsOpen(false); } },
    { id: 'experiments', title: 'Go to Experiments', icon: <Play size={16} />, onSelect: () => { navigate('/experiments'); setIsOpen(false); } },
    { id: 'threats', title: 'Go to Threats', icon: <ShieldAlert size={16} />, onSelect: () => { navigate('/threats'); setIsOpen(false); } },
    { id: 'resilience', title: 'Go to Resilience', icon: <BarChart size={16} />, onSelect: () => { navigate('/resilience'); setIsOpen(false); } },
    { id: 'topology', title: 'Go to Topology', icon: <Activity size={16} />, onSelect: () => { navigate('/topology'); setIsOpen(false); } },
    { id: 'settings', title: 'Go to Settings', icon: <Settings size={16} />, onSelect: () => { navigate('/settings'); setIsOpen(false); } },
    { id: 'toggle-sidebar', title: 'Toggle Sidebar', icon: <PanelLeft size={16} />, onSelect: () => { toggleSidebar(); setIsOpen(false); } },
  ];

  const trimmedQuery = (query || '').trim().toLowerCase();
  const filtered = actions.filter(a => (a.title || '').toLowerCase().includes(trimmedQuery));

  const matchedPublicApis = useMemo(() => {
    if (trimmedQuery.length < 2) return [];
    const tokens = trimmedQuery.split(/\s+/).filter(Boolean);
    const matches = [];
    for (const item of FORTIX_DATASET) {
      const hay = `${item.name} ${item.category} ${item.description}`.toLowerCase();
      if (tokens.every(t => hay.includes(t))) {
        matches.push(item);
        if (matches.length >= 6) break;
      }
    }
    return matches;
  }, [trimmedQuery]);

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 bg-base/80 backdrop-blur-sm z-[99]"
            onClick={() => setIsOpen(false)}
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: -20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -20 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="fixed top-[16%] left-1/2 -translate-x-1/2 w-[92%] max-w-xl bg-card border border-subtle rounded-xl shadow-2xl z-[100] overflow-hidden flex flex-col"
          >
            <div className="flex items-center gap-3 px-4 py-3 border-b border-subtle">
              <Search size={18} className="text-muted shrink-0" />
              <input
                autoFocus
                type="text"
                placeholder="Search pages or 814 public APIs (e.g. weather, stripe, nasa)..."
                value={query}
                onChange={e => setQuery(e.target.value)}
                className="flex-1 bg-transparent border-none text-strong focus:outline-none text-base placeholder:text-muted"
              />
              <div className="text-[10px] font-mono font-bold tracking-widest text-muted border border-subtle px-2 py-1 rounded shrink-0">ESC</div>
            </div>
            <div className="max-h-[62vh] overflow-y-auto p-2 space-y-2">
              {filtered.length > 0 && (
                <div>
                  <div className="px-3 py-1 text-[11px] font-semibold text-muted">Navigation</div>
                  {filtered.map((action) => (
                    <button
                      key={action.id}
                      onClick={action.onSelect}
                      className="w-full flex items-center gap-3 px-3 py-2.5 text-left rounded-lg hover:bg-primary hover:text-inverted text-base-text transition group focus:outline-none focus:bg-primary focus:text-inverted"
                    >
                      <span className="text-muted group-hover:text-inverted group-focus:text-inverted shrink-0">{action.icon}</span>
                      <span className="font-medium text-sm truncate">{action.title}</span>
                    </button>
                  ))}
                </div>
              )}

              {matchedPublicApis.length > 0 && (
                <div className="pt-1 border-t border-subtle">
                  <div className="px-3 py-1 flex items-center justify-between text-[11px] font-semibold text-muted">
                    <span>Public APIs</span>
                    <button
                      onClick={() => {
                        navigate(`/directory?q=${encodeURIComponent(query.trim())}`);
                        setIsOpen(false);
                      }}
                      className="text-primary hover:underline"
                    >
                      View all in Directory
                    </button>
                  </div>
                  {matchedPublicApis.map((api) => (
                    <a
                      key={api.id}
                      href={api.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => setIsOpen(false)}
                      className="w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg hover:bg-hover text-base-text transition"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-strong truncate">{api.name}</div>
                        <div className="text-xs text-muted truncate">
                          {api.category} · {api.description}
                        </div>
                      </div>
                      <ExternalLink size={14} className="text-muted shrink-0" />
                    </a>
                  ))}
                </div>
              )}

              {filtered.length === 0 && matchedPublicApis.length === 0 && (
                <div className="px-4 py-8 text-center text-muted text-sm">
                  No results found for "{query}"
                </div>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
