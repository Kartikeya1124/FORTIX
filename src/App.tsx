import { Login } from "./components/Login.js";
import React, { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Link, Outlet } from 'react-router-dom';
import { Activity, Shield, Server, Play, Settings as SettingsIcon, ShieldAlert, BarChart, Menu, X, LogOut, AlertTriangle, PanelLeft , Moon, Sun } from 'lucide-react';
import Dashboard from './pages/Dashboard.js';
import APIs from './pages/APIs.js';
import Experiments from './pages/Experiments.js';
import Security from './pages/Security.js';
import Resilience from './pages/Resilience.js';
import Threats from './pages/Threats.js';
import Topology from './pages/Topology.js';
import Settings from './pages/Settings.js';
import Verifications from './pages/Verifications.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { CommandPalette } from './components/CommandPalette.js';
import { SocketProvider } from './context/SocketContext.js';
import { ProjectProvider, useProject } from './context/ProjectContext.js';
import { ProjectSwitcher } from './components/ProjectSwitcher.js';

function Layout({ healthStatus }: { healthStatus: { db: string, redis: string } | null }) {
  const [searchQuery, setSearchQuery] = React.useState('');
  const [theme, setTheme] = React.useState(() => localStorage.getItem("fortix_theme") || "light");

  React.useEffect(() => {
    if (theme === "dark") {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
    localStorage.setItem("fortix_theme", theme);
  }, [theme]);

  const [isSidebarOpen, setIsSidebarOpen] = React.useState(false);
  const [isPaletteOpen, setIsPaletteOpen] = React.useState(false);

  const isDegraded = healthStatus && (healthStatus.db === 'error' || healthStatus.redis === 'error');

  return (
    <div className="flex flex-col h-screen w-full bg-transparent text-base-text font-sans overflow-hidden p-0 sm:p-3 md:p-4 lg:p-6">
      <div className="flex flex-col h-full w-full bg-base rounded-none sm:rounded-2xl md:rounded-3xl border-0 sm:border border-subtle overflow-hidden shadow-glass relative isolate">
        <CommandPalette isOpen={isPaletteOpen} setIsOpen={setIsPaletteOpen} toggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)} />
        
        {/* Health Banner */}
        {isDegraded && (
          <div className="bg-red-900/40 text-red-400 text-xs md:text-sm font-bold px-4 py-2 text-center border-b border-red-500/50 flex items-center justify-center gap-2 shrink-0 z-50">
            <AlertTriangle size={16} />
            <span>
              SYSTEM DEGRADED: {healthStatus.db === 'error' ? 'PostgreSQL' : ''} {healthStatus.db === 'error' && healthStatus.redis === 'error' ? 'and' : ''} {healthStatus.redis === 'error' ? 'Redis' : ''} {healthStatus.db === 'error' && healthStatus.redis === 'error' ? 'are' : 'is'} currently unavailable.
            </span>
          </div>
        )}

        {/* Header */}
        <header className="flex items-center justify-between px-4 md:px-6 py-4 border-b border-subtle bg-surface shrink-0">
          <div className="flex items-center gap-3 md:gap-4">
            <button 
              className="md:hidden text-muted hover:text-strong transition"
              onClick={() => setIsSidebarOpen(!isSidebarOpen)}
            >
              {isSidebarOpen ? <X size={24} /> : <Menu size={24} />}
            </button>
            <div className="flex items-center justify-center w-8 h-8 md:w-10 md:h-10 rounded-xl bg-primary text-inverted font-bold text-lg md:text-xl shrink-0">FX</div>
            <div className="hidden sm:block">
              <h1 className="text-lg font-bold tracking-tight text-strong leading-none uppercase">
                FortiX <span className="text-primary text-xs align-top ml-1">GATEWAY V1</span>
              </h1>
            </div>
            {/* Desktop Project Switcher */}
            <div className="hidden sm:block ml-2 pl-3 border-l border-subtle">
              <ProjectSwitcher />
            </div>
          </div>
          
          {/* Global Search Bar */}
          <div className="flex-1 max-w-md mx-4 md:mx-8">
            <input 
              type="text" 
              placeholder="Search or jump to... (Ctrl+K)" 
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full bg-base border border-subtle text-sm text-strong px-4 py-2 rounded-xl focus:outline-none focus:border-primary transition-colors"
            />
          </div>

          <div className="flex items-center gap-3">
            {/* Mobile Project Switcher */}
            <div className="sm:hidden">
              <ProjectSwitcher />
            </div>
            <div className="hidden lg:flex gap-6">
              <div className="flex flex-col items-end">
                <span className="text-[10px] uppercase text-muted font-bold tracking-widest">System Status</span>
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${isDegraded ? 'bg-amber-500 animate-pulse' : 'bg-emerald-500 animate-pulse'}`}></div>
                  <span className={`text-sm font-mono font-bold ${isDegraded ? 'text-amber-400' : 'text-strong'}`}>
                    {isDegraded ? 'DEGRADED' : 'OPERATIONAL'}
                  </span>
                </div>
              </div>
              <div className="flex items-center pl-4 border-l border-subtle gap-4">
                <button
                  onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                  className="flex items-center gap-2 text-muted hover:text-strong transition-colors"
                  title="Toggle Theme"
                >
                  {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
                </button>
                <button
                  onClick={() => {
                    localStorage.removeItem('fortix_token'); window.location.reload();
                  }}
                  className="flex items-center gap-2 text-muted hover:text-strong transition-colors"
                  title="Logout"
                >
                  <LogOut size={18} />
                </button>
              </div>
            </div>
          </div>
        </header>

        {/* Main Content Area */}
        <main className="flex flex-1 overflow-hidden relative">
          {/* Mobile Overlay */}
          {isSidebarOpen && (
            <div 
              className="absolute inset-0 bg-base/80 z-40 md:hidden" 
              onClick={() => setIsSidebarOpen(false)} 
            />
          )}

          {/* Sidebar */}
          <aside className={`absolute z-50 md:relative h-full w-56 border-r border-subtle bg-transparent p-4 flex flex-col gap-2 shrink-0 transition-transform duration-300 ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}`}>
            <div className="text-[11px] font-bold text-muted uppercase tracking-widest mb-2 px-2">Navigation</div>
            <nav className="flex-1 space-y-1">
              <NavItem to="/" icon={<Activity size={16} />} label="Dashboard" onClick={() => setIsSidebarOpen(false)} />
              <NavItem to="/apis" icon={<Server size={16} />} label="APIs" onClick={() => setIsSidebarOpen(false)} />
              <NavItem to="/security" icon={<Shield size={16} />} label="Security" onClick={() => setIsSidebarOpen(false)} />
              <NavItem to="/experiments" icon={<Play size={16} />} label="Experiments" onClick={() => setIsSidebarOpen(false)} />
              <NavItem to="/resilience" icon={<BarChart size={16} />} label="Resilience" onClick={() => setIsSidebarOpen(false)} />
              <NavItem to="/threats" icon={<ShieldAlert size={16} />} label="Threats" onClick={() => setIsSidebarOpen(false)} />
              <NavItem to="/topology" icon={<Activity size={16} />} label="Topology" onClick={() => setIsSidebarOpen(false)} />
              <NavItem to="/verifications" icon={<Shield size={16} />} label="Verifications" onClick={() => setIsSidebarOpen(false)} />
              <NavItem to="/settings" icon={<SettingsIcon size={16} />} label="Settings" onClick={() => setIsSidebarOpen(false)} />
            </nav>
            <div className="mt-auto p-3 bg-elevated rounded-lg border border-subtle shadow-glass">
              <div className="text-[10px] text-muted uppercase font-bold mb-1">Environment</div>
              <div className="text-xs font-mono text-primary font-bold">production-sandbox</div>
              <div className="text-[10px] text-muted mt-1">FortiX Resilient Gateway</div>
            </div>
          </aside>

          {/* Page Content */}
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex-1 p-6 overflow-y-auto">
              <ErrorBoundary>
                <Outlet context={{ searchQuery, theme, setTheme }} />
              </ErrorBoundary>
            </div>
          </div>
        </main>
        
        <footer className="px-6 py-2.5 border-t border-subtle bg-surface flex justify-between items-center shrink-0">
          <div className="text-[10px] text-muted">© 2026 Faultline Labs // FortiX Continuous Resilience & API Security Gateway</div>
        </footer>
      </div>
    </div>
  );
}

function NavItem({ to, icon, label, onClick }: { to: string, icon: React.ReactNode, label: string, onClick?: () => void }) {
  return (
    <Link to={to} onClick={onClick} className="flex items-center gap-3 px-3 py-2 rounded-xl text-muted hover:bg-hover hover:text-strong transition-colors border-l-2 border-transparent">
      <span className="w-4 h-4 text-center">{icon}</span>
      <span className="text-sm font-medium">{label}</span>
    </Link>
  );
}

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = React.useState(false);
  const [isLoadingAuth, setIsLoadingAuth] = React.useState(true);

  React.useEffect(() => {
    fetch('/api/auth/me', { headers: { 'X-Fortix-Token': localStorage.getItem('fortix_token') || '' } }).then(res => {
      if (res.ok) setIsAuthenticated(true);
      setIsLoadingAuth(false);
    }).catch(() => setIsLoadingAuth(false));

    const handleUnauthorized = () => {
      setIsAuthenticated(false);
    };
    window.addEventListener('fortix:auth-unauthorized', handleUnauthorized);
    return () => window.removeEventListener('fortix:auth-unauthorized', handleUnauthorized);
  }, []);
  const [healthStatus, setHealthStatus] = React.useState<{ db: string, redis: string } | null>(null);

  React.useEffect(() => {
    const checkHealth = async () => {
      try {
        const res = await fetch('/api/health');
        if (res.ok || res.status === 503) {
          const data = await res.json();
          const pgOk = (data.postgres?.status === 'healthy' || data.db === 'healthy');
          const rdOk = (data.redis?.status === 'healthy' || data.redis === 'healthy');
          setHealthStatus({
            db: pgOk ? 'healthy' : 'error',
            redis: rdOk ? 'healthy' : 'error'
          });
          return;
        }
        setHealthStatus({ db: 'error', redis: 'error' });
      } catch (err) {
        setHealthStatus({ db: 'error', redis: 'error' });
      }
    };
    checkHealth();
    const intervalId = setInterval(checkHealth, 30000);
    return () => clearInterval(intervalId);
  }, []);

  if (isLoadingAuth) return <div className="flex h-screen w-full items-center justify-center bg-base text-muted">Loading FortiX...</div>;

  if (!isAuthenticated) return (
    <>
      {healthStatus && (healthStatus.db === 'error' || healthStatus.redis === 'error') && (
        <div className="bg-red-900/40 text-red-400 text-xs md:text-sm font-bold px-4 py-2 text-center border-b border-red-500/50 flex items-center justify-center gap-2 absolute top-0 w-full z-50">
          <AlertTriangle size={16} />
          <span>
            SYSTEM DEGRADED: {healthStatus.db === 'error' ? 'PostgreSQL' : ''} {healthStatus.db === 'error' && healthStatus.redis === 'error' ? 'and' : ''} {healthStatus.redis === 'error' ? 'Redis' : ''} {healthStatus.db === 'error' && healthStatus.redis === 'error' ? 'are' : 'is'} currently unavailable.
          </span>
        </div>
      )}
      <Login onLogin={() => setIsAuthenticated(true)} />
    </>
  );

function SocketWrapper({ children }: { children: React.ReactNode }) {
  const { currentProject } = useProject();
  return (
    <SocketProvider projectId={currentProject?.id}>
      {children}
    </SocketProvider>
  );
}

  return (
    <BrowserRouter>
      <ProjectProvider>
        <SocketWrapper>
          <Routes>
            <Route path="/" element={<Layout healthStatus={healthStatus} />}>
              <Route index element={<Dashboard />} />
              <Route path="apis" element={<APIs />} />
              <Route path="security" element={<Security />} />
              <Route path="experiments" element={<Experiments />} />
              <Route path="resilience" element={<Resilience />} />
              <Route path="threats" element={<Threats />} />
              <Route path="topology" element={<Topology />} />
              <Route path="verifications" element={<Verifications />} />
              <Route path="settings" element={<Settings />} />
              <Route path="*" element={<div className="p-8 text-center text-muted">Feature in development</div>} />
            </Route>
          </Routes>
        </SocketWrapper>
      </ProjectProvider>
    </BrowserRouter>
  );
}
