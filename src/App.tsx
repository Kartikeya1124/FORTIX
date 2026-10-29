import { Login } from './components/Login.js';
import React from 'react';
import { BrowserRouter, Routes, Route, Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Activity,
  Shield,
  Server,
  Play,
  Settings as SettingsIcon,
  ShieldAlert,
  BarChart,
  Menu,
  X,
  LogOut,
  AlertTriangle,
  Moon,
  Sun,
  Globe,
} from 'lucide-react';
import Dashboard from './pages/Dashboard.js';
import APIs from './pages/APIs.js';
import PublicApiDirectory from './pages/PublicApiDirectory.js';
import Experiments from './pages/Experiments.js';
import Security from './pages/Security.js';
import Resilience from './pages/Resilience.js';
import Threats from './pages/Threats.js';
import Topology from './pages/Topology.js';
import Settings from './pages/Settings.js';
import Verifications from './pages/Verifications.js';
import NotFound from './pages/NotFound.js';
import { PrivacyPolicyPage, TermsOfUsePage } from './pages/LegalPages.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { CommandPalette } from './components/CommandPalette.js';
import { SocketProvider } from './context/SocketContext.js';
import { ProjectProvider, useProject } from './context/ProjectContext.js';
import { ProjectSwitcher } from './components/ProjectSwitcher.js';
import { getCsrfToken, setCsrfToken } from './lib/api.js';

function Layout({
  healthStatus,
  theme,
  setTheme,
  onLogout,
}: {
  healthStatus: { db: string; redis: string } | null;
  theme: string;
  setTheme: React.Dispatch<React.SetStateAction<string>>;
  onLogout: () => Promise<void>;
}) {
  const [searchQuery, setSearchQuery] = React.useState('');
  const navigate = useNavigate();
  const location = useLocation();

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
        <header className="flex items-center justify-between px-3 sm:px-4 md:px-6 py-3.5 border-b border-subtle bg-surface shrink-0 gap-2 sm:gap-4">
          <div className="flex items-center gap-2 sm:gap-3 md:gap-4 min-w-0 shrink">
            <button
              className="md:hidden text-muted hover:text-strong transition shrink-0"
              onClick={() => setIsSidebarOpen(!isSidebarOpen)}
              aria-label="Toggle navigation menu"
            >
              {isSidebarOpen ? <X size={22} /> : <Menu size={22} />}
            </button>
            <div className="flex items-center justify-center w-8 h-8 md:w-9 md:h-9 rounded-xl bg-primary text-inverted font-bold text-base md:text-lg shrink-0">FX</div>
            <div className="hidden lg:block shrink-0">
              <h1 className="text-base font-bold tracking-tight text-strong leading-none uppercase">
                FortiX <span className="text-primary text-[10px] align-top ml-0.5">GATEWAY</span>
              </h1>
            </div>
            <div className="hidden sm:block ml-1 sm:ml-2 pl-2 sm:pl-3 border-l border-subtle min-w-0 max-w-[180px] md:max-w-[220px] lg:max-w-[260px]">
              <ProjectSwitcher />
            </div>
          </div>

          <div className="flex-1 min-w-[100px] max-w-xs sm:max-w-sm md:max-w-md mx-1 sm:mx-2 md:mx-4">
            <input
              type="text"
              placeholder="Search APIs or press Enter for 800+ Public APIs... (Ctrl+K)"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && searchQuery.trim() && location.pathname !== '/directory') {
                  navigate(`/directory?q=${encodeURIComponent(searchQuery.trim())}`);
                }
              }}
              className="w-full bg-white dark:bg-[#0d1017] border border-zinc-300 dark:border-white/20 text-xs sm:text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-500 px-3 sm:px-4 py-1.5 sm:py-2 rounded-xl focus:outline-none focus:border-primary transition-colors truncate"
            />
          </div>

          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            <div className="sm:hidden">
              <ProjectSwitcher />
            </div>
            <div className="hidden lg:flex flex-col items-end mr-2">
              <span className="text-[10px] uppercase text-muted font-bold tracking-widest">System Status</span>
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${isDegraded ? 'bg-amber-500 animate-pulse' : 'bg-emerald-500 animate-pulse'}`}></div>
                <span className={`text-sm font-mono font-bold ${isDegraded ? 'text-amber-400' : 'text-strong'}`}>
                  {isDegraded ? 'DEGRADED' : 'OPERATIONAL'}
                </span>
              </div>
            </div>
            <div className="flex items-center pl-2 sm:pl-4 border-l border-subtle gap-2.5 sm:gap-4">
              <button
                onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                className="flex items-center gap-2 text-muted hover:text-strong transition-colors"
                title="Toggle Theme"
                aria-label="Toggle Theme"
              >
                {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
              </button>
              <button
                onClick={onLogout}
                className="flex items-center gap-2 text-muted hover:text-strong transition-colors"
                title="Sign Out"
                aria-label="Sign Out"
              >
                <LogOut size={18} />
              </button>
            </div>
          </div>
        </header>

        {/* Main Content Area */}
        <main className="flex flex-1 overflow-hidden relative">
          {isSidebarOpen && (
            <div
              className="absolute inset-0 bg-base/80 z-40 md:hidden"
              onClick={() => setIsSidebarOpen(false)}
            />
          )}

          <aside className={`absolute z-50 md:relative h-full w-56 border-r border-subtle bg-surface md:bg-transparent p-4 flex flex-col gap-2 shrink-0 transition-transform duration-300 ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}`}>
            <div className="text-[11px] font-bold text-muted uppercase tracking-widest mb-2 px-2">Navigation</div>
            <nav className="flex-1 space-y-1 overflow-y-auto">
              <NavItem to="/" icon={<Activity size={16} />} label="Dashboard" active={location.pathname === '/'} onClick={() => setIsSidebarOpen(false)} />
              <NavItem to="/apis" icon={<Server size={16} />} label="Protected APIs" active={location.pathname === '/apis'} onClick={() => setIsSidebarOpen(false)} />
              <NavItem to="/directory" icon={<Globe size={16} />} label="Public APIs" active={location.pathname === '/directory'} onClick={() => setIsSidebarOpen(false)} />
              <NavItem to="/security" icon={<Shield size={16} />} label="Security" active={location.pathname === '/security'} onClick={() => setIsSidebarOpen(false)} />
              <NavItem to="/experiments" icon={<Play size={16} />} label="Experiments" active={location.pathname === '/experiments'} onClick={() => setIsSidebarOpen(false)} />
              <NavItem to="/resilience" icon={<BarChart size={16} />} label="Resilience" active={location.pathname === '/resilience'} onClick={() => setIsSidebarOpen(false)} />
              <NavItem to="/threats" icon={<ShieldAlert size={16} />} label="Threats" active={location.pathname === '/threats'} onClick={() => setIsSidebarOpen(false)} />
              <NavItem to="/topology" icon={<Activity size={16} />} label="Topology" active={location.pathname === '/topology'} onClick={() => setIsSidebarOpen(false)} />
              <NavItem to="/verifications" icon={<Shield size={16} />} label="Verifications" active={location.pathname === '/verifications'} onClick={() => setIsSidebarOpen(false)} />
              <NavItem to="/settings" icon={<SettingsIcon size={16} />} label="Settings" active={location.pathname === '/settings'} onClick={() => setIsSidebarOpen(false)} />
            </nav>
            <div className="mt-auto p-3 bg-elevated rounded-lg border border-subtle shadow-glass">
              <div className="text-[10px] text-muted uppercase font-bold mb-1">Environment</div>
              <div className="text-xs font-mono text-primary font-bold">control-plane</div>
              <div className="text-[10px] text-muted mt-1">FortiX Resilient Gateway</div>
            </div>
          </aside>

          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex-1 p-4 sm:p-6 overflow-y-auto">
              <ErrorBoundary>
                <Outlet context={{ searchQuery, theme, setTheme }} />
              </ErrorBoundary>
            </div>
          </div>
        </main>

        <footer className="px-4 sm:px-6 py-2.5 border-t border-subtle bg-surface flex flex-wrap justify-between items-center gap-2 shrink-0">
          <div className="text-[11px] text-muted">© 2026 Faultline Labs · FortiX Continuous Resilience &amp; API Security Gateway</div>
          <div className="flex items-center gap-4 text-[11px] text-muted">
            <Link to="/privacy" className="hover:text-strong transition-colors">Privacy Policy</Link>
            <Link to="/terms" className="hover:text-strong transition-colors">Terms of Use</Link>
          </div>
        </footer>
      </div>
    </div>
  );
}

function NavItem({ to, icon, label, active, onClick }: { to: string; icon: React.ReactNode; label: string; active?: boolean; onClick?: () => void }) {
  return (
    <Link
      to={to}
      onClick={onClick}
      className={`flex items-center gap-3 px-3 py-2 rounded-xl transition-colors whitespace-nowrap ${
        active
          ? 'bg-primary text-inverted font-semibold'
          : 'text-muted hover:bg-hover hover:text-strong'
      }`}
    >
      <span className="w-4 h-4 flex items-center justify-center shrink-0">{icon}</span>
      <span className="text-sm truncate">{label}</span>
    </Link>
  );
}

function SocketWrapper({ children }: { children: React.ReactNode }) {
  const { currentProject } = useProject();
  return <SocketProvider projectId={currentProject?.id}>{children}</SocketProvider>;
}

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = React.useState(false);
  const [isLoadingAuth, setIsLoadingAuth] = React.useState(true);
  const [theme, setTheme] = React.useState(() => localStorage.getItem('fortix_theme_v2') || 'dark');
  const [healthStatus, setHealthStatus] = React.useState<{ db: string; redis: string } | null>(null);

  React.useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    localStorage.setItem('fortix_theme_v2', theme);
    localStorage.setItem('fortix_theme', theme);
  }, [theme]);

  React.useEffect(() => {
    try {
      localStorage.removeItem('fortix_token');
    } catch {
      // Ignore storage access errors
    }

    fetch('/api/auth/me', { credentials: 'include' })
      .then(async (res) => {
        if (res.ok) {
          const data = await res.json().catch(() => ({}));
          if (data.csrfToken) setCsrfToken(data.csrfToken);
          setIsAuthenticated(true);
        }
        setIsLoadingAuth(false);
      })
      .catch(() => setIsLoadingAuth(false));

    const handleUnauthorized = () => {
      setCsrfToken(null);
      setIsAuthenticated(false);
    };
    window.addEventListener('fortix:auth-unauthorized', handleUnauthorized);
    return () => window.removeEventListener('fortix:auth-unauthorized', handleUnauthorized);
  }, []);

  React.useEffect(() => {
    const checkHealth = async () => {
      try {
        const res = await fetch('/api/health');
        if (res.ok || res.status === 503) {
          const data = await res.json();
          const pgOk = data.postgres?.status === 'healthy' || data.db === 'healthy';
          const rdOk = data.redis?.status === 'healthy' || data.redis === 'healthy';
          setHealthStatus({
            db: pgOk ? 'healthy' : 'error',
            redis: rdOk ? 'healthy' : 'error',
          });
          return;
        }
        setHealthStatus({ db: 'error', redis: 'error' });
      } catch {
        setHealthStatus({ db: 'error', redis: 'error' });
      }
    };
    checkHealth();
    const intervalId = setInterval(checkHealth, 30000);
    return () => clearInterval(intervalId);
  }, []);

  const handleLogout = React.useCallback(async () => {
    try {
      const csrf = getCsrfToken();
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
        headers: {
          ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
          'X-Requested-With': 'FortiX-Control-Plane',
        },
      });
    } catch {
      // Proceed with client session teardown even on network interruption
    } finally {
      setCsrfToken(null);
      try {
        localStorage.removeItem('fortix_token');
        localStorage.removeItem('fortix_project_id');
      } catch {}
      setIsAuthenticated(false);
    }
  }, []);

  if (isLoadingAuth) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-[#090b10] text-zinc-400 font-sans text-sm">
        Loading FortiX Gateway...
      </div>
    );
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/privacy" element={<PrivacyPolicyPage />} />
        <Route path="/terms" element={<TermsOfUsePage />} />
        {!isAuthenticated ? (
          <Route
            path="*"
            element={
              <div className="dark min-h-screen w-full bg-[#090b10] text-zinc-100 relative">
                {healthStatus && (healthStatus.db === 'error' || healthStatus.redis === 'error') && (
                  <div className="bg-red-950/90 text-red-300 text-xs md:text-sm font-semibold px-4 py-2.5 text-center border-b border-red-500/40 flex items-center justify-center gap-2 fixed top-0 inset-x-0 z-50 backdrop-blur-md">
                    <AlertTriangle size={16} />
                    <span>
                      System degraded: {healthStatus.db === 'error' ? 'PostgreSQL' : ''} {healthStatus.db === 'error' && healthStatus.redis === 'error' ? 'and' : ''} {healthStatus.redis === 'error' ? 'Redis' : ''} {healthStatus.db === 'error' && healthStatus.redis === 'error' ? 'are' : 'is'} currently unavailable.
                    </span>
                  </div>
                )}
                <Login onLogin={() => setIsAuthenticated(true)} />
              </div>
            }
          />
        ) : (
          <Route
            path="/"
            element={
              <ProjectProvider>
                <SocketWrapper>
                  <Layout
                    healthStatus={healthStatus}
                    theme={theme}
                    setTheme={setTheme}
                    onLogout={handleLogout}
                  />
                </SocketWrapper>
              </ProjectProvider>
            }
          >
            <Route index element={<Dashboard />} />
            <Route path="apis" element={<APIs />} />
            <Route path="directory" element={<PublicApiDirectory />} />
            <Route path="security" element={<Security />} />
            <Route path="experiments" element={<Experiments />} />
            <Route path="resilience" element={<Resilience />} />
            <Route path="threats" element={<Threats />} />
            <Route path="topology" element={<Topology />} />
            <Route path="verifications" element={<Verifications />} />
            <Route path="settings" element={<Settings />} />
            <Route path="*" element={<NotFound isAuthenticated={true} />} />
          </Route>
        )}
      </Routes>
    </BrowserRouter>
  );
}
