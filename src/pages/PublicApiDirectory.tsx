import React, { useMemo, useState, useEffect } from 'react';
import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
import {
  Search,
  ExternalLink,
  Copy,
  Check,
  Bookmark,
  Plus,
  RotateCcw,
  ChevronLeft,
  ChevronRight,
  ArrowUpRight,
} from 'lucide-react';
import { FORTIX_DATASET } from '../data/publicApisDataset.js';
import { ApiItem } from '../types/publicApi.js';
import { fetchWithAuth } from '../lib/api.js';
import { useProject } from '../context/ProjectContext.js';

const FAVORITES_STORAGE_KEY = 'fortix_public_api_favorites';
const PAGE_SIZE = 24;

type AuthFilter = 'all' | 'none' | 'header' | 'oauth2';
type QuickPreset = 'all' | 'open' | 'cors' | 'security' | 'ml' | 'finance' | 'saved';

function getSafeExternalHref(urlStr?: string): string | null {
  if (!urlStr || typeof urlStr !== 'string') return null;
  try {
    const parsed = new URL(urlStr.trim());
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return null;
    }
    if (parsed.username || parsed.password) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function getHostname(urlStr: string): string {
  try {
    return new URL(urlStr).hostname.replace(/^www\./, '');
  } catch {
    return urlStr;
  }
}

function getAuthLabel(authType: string): string {
  switch (authType) {
    case 'none':
      return 'Open Access (No Key)';
    case 'header':
      return 'API Key';
    case 'oauth2':
      return 'OAuth 2.0';
    default:
      return authType || 'Open Access';
  }
}

function isHttpsItem(item: ApiItem): boolean {
  return item.url.startsWith('https://') || item.tags.includes('https');
}

function isCorsItem(item: ApiItem): boolean {
  return item.tags.includes('cors-enabled') || Boolean(item.notes && item.notes.includes('CORS: Yes'));
}

function toRouteSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'external';
}

export default function PublicApiDirectory() {
  const { currentProject } = useProject();
  const outletContext = useOutletContext<{ searchQuery?: string }>() || {};
  const [searchParams, setSearchParams] = useSearchParams();

  const [localQuery, setLocalQuery] = useState(() => searchParams.get('q') || '');
  const [selectedCategory, setSelectedCategory] = useState<string>(() => searchParams.get('category') || 'All');
  const [authFilter, setAuthFilter] = useState<AuthFilter>('all');
  const [httpsOnly, setHttpsOnly] = useState(false);
  const [corsOnly, setCorsOnly] = useState(false);
  const [savedOnly, setSavedOnly] = useState(false);
  const [activePreset, setActivePreset] = useState<QuickPreset>('all');
  const [page, setPage] = useState(1);

  const [favorites, setFavorites] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem(FAVORITES_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) return new Set(parsed);
      }
    } catch {
      // ignore storage errors
    }
    return new Set();
  });

  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [pendingRouteItem, setPendingRouteItem] = useState<ApiItem | null>(null);
  const [importingId, setImportingId] = useState<string | null>(null);
  const [importedIds, setImportedIds] = useState<Set<string>>(new Set());
  const [importFeedback, setImportFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Sync URL query param if navigated from CommandPalette or link
  useEffect(() => {
    const paramQ = searchParams.get('q');
    const paramCat = searchParams.get('category');
    if (paramQ !== null && paramQ !== localQuery) {
      setLocalQuery(paramQ);
    }
    if (paramCat !== null && paramCat !== selectedCategory) {
      setSelectedCategory(paramCat);
    }
  }, [searchParams]);

  const effectiveQuery = (localQuery || outletContext.searchQuery || '').trim();

  // Reset pagination whenever filters change
  useEffect(() => {
    setPage(1);
  }, [effectiveQuery, selectedCategory, authFilter, httpsOnly, corsOnly, savedOnly, activePreset]);

  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of FORTIX_DATASET) {
      counts.set(item.category, (counts.get(item.category) || 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, []);

  const summaryStats = useMemo(() => {
    let openCount = 0;
    let corsCount = 0;
    for (const item of FORTIX_DATASET) {
      if (item.authType === 'none') openCount++;
      if (isCorsItem(item)) corsCount++;
    }
    return {
      total: FORTIX_DATASET.length,
      categories: categories.length,
      openCount,
      corsCount,
    };
  }, [categories]);

  const filteredItems = useMemo(() => {
    const tokens = effectiveQuery
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);

    return FORTIX_DATASET.filter((item) => {
      if (selectedCategory !== 'All' && item.category !== selectedCategory) {
        return false;
      }

      if (activePreset === 'open' && item.authType !== 'none') return false;
      if (activePreset === 'cors' && !isCorsItem(item)) return false;
      if (activePreset === 'security' && item.category !== 'Security' && item.category !== 'Anti-Malware') return false;
      if (activePreset === 'ml' && item.category !== 'Machine Learning') return false;
      if (
        activePreset === 'finance' &&
        item.category !== 'Finance' &&
        item.category !== 'Cryptocurrency' &&
        item.category !== 'Currency Exchange'
      ) {
        return false;
      }
      if ((activePreset === 'saved' || savedOnly) && !favorites.has(item.id)) {
        return false;
      }

      if (authFilter !== 'all' && item.authType !== authFilter) {
        return false;
      }

      if (httpsOnly && !isHttpsItem(item)) {
        return false;
      }

      if (corsOnly && !isCorsItem(item)) {
        return false;
      }

      if (tokens.length > 0) {
        const cleanTags = item.tags.map((t) => t.replace(/\\/g, '')).join(' ');
        const haystack = `${item.name} ${item.category} ${item.description} ${cleanTags} ${item.url} ${getAuthLabel(item.authType)}`.toLowerCase();
        for (const token of tokens) {
          if (!haystack.includes(token)) {
            return false;
          }
        }
      }

      return true;
    });
  }, [effectiveQuery, selectedCategory, authFilter, httpsOnly, corsOnly, savedOnly, activePreset, favorites]);

  const totalPages = Math.max(1, Math.ceil(filteredItems.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paginatedItems = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE;
    return filteredItems.slice(start, start + PAGE_SIZE);
  }, [filteredItems, safePage]);

  const toggleFavorite = (id: string) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      try {
        localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(Array.from(next)));
      } catch {
        // ignore storage errors
      }
      return next;
    });
  };

  const handleCopyUrl = async (item: ApiItem) => {
    try {
      await navigator.clipboard.writeText(item.url);
      setCopiedId(item.id);
      setTimeout(() => {
        setCopiedId((prev) => (prev === item.id ? null : prev));
      }, 1800);
    } catch {
      // clipboard unavailable
    }
  };

  const confirmImportToGateway = async (item: ApiItem) => {
    const safeTarget = getSafeExternalHref(item.url);
    if (!safeTarget || !safeTarget.startsWith('https://')) {
      setPendingRouteItem(null);
      setImportFeedback({ type: 'error', message: 'Only valid HTTPS target URLs without embedded credentials can be registered.' });
      return;
    }

    const projectId = currentProject?.id || localStorage.getItem('fortix_project_id') || '';
    if (!projectId) {
      setPendingRouteItem(null);
      setImportFeedback({ type: 'error', message: 'Select or create an active project first before importing a route.' });
      return;
    }

    setPendingRouteItem(null);
    setImportingId(item.id);
    setImportFeedback(null);
    const pathPattern = `/api/public/${toRouteSlug(item.name)}`;

    try {
      const res = await fetchWithAuth('/api/control/routes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          pathPattern,
          targetUrl: safeTarget,
        }),
      });

      if (res.ok) {
        setImportedIds((prev) => new Set(prev).add(item.id));
        setImportFeedback({
          type: 'success',
          message: `Registered "${item.name}" at ${pathPattern} in ${currentProject?.name || 'your active project'}.`,
        });
      } else {
        const err = await res.json().catch(() => ({}));
        setImportFeedback({
          type: 'error',
          message: err.error || `Could not register "${item.name}" as a gateway route.`,
        });
      }
    } catch {
      setImportFeedback({
        type: 'error',
        message: `Network error while registering "${item.name}".`,
      });
    } finally {
      setImportingId(null);
    }
  };

  const resetAllFilters = () => {
    setLocalQuery('');
    setSelectedCategory('All');
    setAuthFilter('all');
    setHttpsOnly(false);
    setCorsOnly(false);
    setSavedOnly(false);
    setActivePreset('all');
    setSearchParams({});
  };

  const applyPreset = (preset: QuickPreset) => {
    setActivePreset(preset);
    if (preset !== 'all') {
      setSelectedCategory('All');
    }
    if (preset === 'saved') {
      setSavedOnly(true);
    } else {
      setSavedOnly(false);
    }
  };

  const hasActiveFilters =
    Boolean(effectiveQuery) ||
    selectedCategory !== 'All' ||
    authFilter !== 'all' ||
    httpsOnly ||
    corsOnly ||
    savedOnly ||
    activePreset !== 'all';

  return (
    <div className="space-y-6">
      {/* Header & Catalog Summary */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 pb-5 border-b border-subtle">
        <div className="space-y-1.5 max-w-2xl">
          <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-strong">
            Public API Directory
          </h2>
          <p className="text-sm text-muted leading-relaxed">
            Search, filter, and open verified public APIs matched to your authentication, protocol, CORS, and domain requirements—or register any endpoint directly into your FortiX Gateway project.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted font-mono tabular-nums shrink-0">
          <span>
            <strong className="text-strong font-semibold">{summaryStats.total}</strong> Total APIs
          </span>
          <span aria-hidden="true">·</span>
          <span>
            <strong className="text-strong font-semibold">{summaryStats.categories}</strong> Categories
          </span>
          <span aria-hidden="true">·</span>
          <span>
            <strong className="text-strong font-semibold">{summaryStats.openCount}</strong> Open (No Key)
          </span>
          <span aria-hidden="true">·</span>
          <span>
            <strong className="text-strong font-semibold">{summaryStats.corsCount}</strong> CORS Ready
          </span>
        </div>
      </div>

      {/* Inline Feedback Banner for Gateway Route Registration */}
      {importFeedback && (
        <div
          className={`flex flex-wrap items-center justify-between gap-3 px-4 py-3 rounded-xl border text-sm ${
            importFeedback.type === 'success'
              ? 'bg-emerald-500/10 border-emerald-500/30 text-strong'
              : 'bg-red-500/10 border-red-500/30 text-red-400'
          }`}
        >
          <span>{importFeedback.message}</span>
          <div className="flex items-center gap-4 shrink-0">
            {importFeedback.type === 'success' && (
              <Link
                to="/apis"
                className="text-xs font-semibold text-primary hover:underline whitespace-nowrap shrink-0"
              >
                Open Protected APIs
              </Link>
            )}
            <button
              onClick={() => setImportFeedback(null)}
              className="text-xs font-medium text-muted hover:text-strong whitespace-nowrap shrink-0"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Requirement Search & Interactive Filter Controls */}
      <div className="bg-card border border-subtle rounded-xl p-4 sm:p-5 space-y-4">
        <div className="flex flex-col md:flex-row gap-3">
          <div className="relative flex-1">
            <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
            <input
              type="text"
              value={localQuery}
              onChange={(e) => {
                const val = e.target.value;
                setLocalQuery(val);
                if (val.trim()) {
                  setSearchParams({ q: val });
                } else {
                  setSearchParams({});
                }
              }}
              placeholder="Describe your requirement (e.g. weather forecast, currency exchange, malware scan, free pdf, open-meteo)..."
              className="w-full bg-base border border-subtle text-sm text-strong pl-10 pr-4 py-2.5 rounded-lg focus:outline-none focus:border-primary transition-colors"
            />
          </div>

          {/* Mobile Category Selector */}
          <div className="lg:hidden sm:w-60">
            <select
              aria-label="Filter by category"
              value={selectedCategory}
              onChange={(e) => {
                setSelectedCategory(e.target.value);
                setActivePreset('all');
              }}
              className="w-full bg-base border border-subtle text-sm text-strong px-3 py-2.5 rounded-lg focus:outline-none focus:border-primary"
            >
              <option value="All">All Categories ({FORTIX_DATASET.length})</option>
              {categories.map(([cat, count]) => (
                <option key={cat} value={cat}>
                  {cat} ({count})
                </option>
              ))}
            </select>
          </div>

          {hasActiveFilters && (
            <button
              onClick={resetAllFilters}
              className="inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-medium text-muted hover:text-strong bg-base border border-subtle rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <RotateCcw size={14} />
              Reset Filters
            </button>
          )}
        </div>

        {/* Quick Requirement Presets & Auth / Protocol Controls */}
        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-3 pt-1">
          {/* Quick Requirement Presets */}
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 xl:pb-0">
            {(
              [
                { id: 'all', label: 'All Requirements' },
                { id: 'open', label: 'No Key Needed' },
                { id: 'cors', label: 'Browser CORS Ready' },
                { id: 'security', label: 'Security & Threat Intel' },
                { id: 'ml', label: 'AI & Machine Learning' },
                { id: 'finance', label: 'Finance & Crypto' },
                { id: 'saved', label: `Saved (${favorites.size})` },
              ] as { id: QuickPreset; label: string }[]
            ).map((preset) => (
              <button
                key={preset.id}
                onClick={() => applyPreset(preset.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 tabular-nums ${
                  activePreset === preset.id
                    ? 'bg-primary text-inverted'
                    : 'bg-hover text-muted hover:text-strong'
                }`}
              >
                {preset.label}
              </button>
            ))}
          </div>

          {/* Auth & Transport Filter Controls */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex items-center p-1 bg-base border border-subtle rounded-lg">
              {(
                [
                  { id: 'all', label: 'Any Auth' },
                  { id: 'none', label: 'Open' },
                  { id: 'header', label: 'API Key' },
                  { id: 'oauth2', label: 'OAuth 2.0' },
                ] as { id: AuthFilter; label: string }[]
              ).map((opt) => (
                <button
                  key={opt.id}
                  onClick={() => setAuthFilter(opt.id)}
                  className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                    authFilter === opt.id
                      ? 'bg-surface text-strong shadow-xs'
                      : 'text-muted hover:text-strong'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            <button
              onClick={() => setHttpsOnly(!httpsOnly)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
                httpsOnly
                  ? 'border-primary text-primary bg-primary/10'
                  : 'border-subtle text-muted hover:text-strong bg-base'
              }`}
            >
              HTTPS Only
            </button>

            <button
              onClick={() => setCorsOnly(!corsOnly)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
                corsOnly
                  ? 'border-primary text-primary bg-primary/10'
                  : 'border-subtle text-muted hover:text-strong bg-base'
              }`}
            >
              CORS Enabled
            </button>
          </div>
        </div>
      </div>

      {/* Main Directory Workspace: Left Category Rail + Right API Grid */}
      <div className="flex flex-col lg:flex-row items-start gap-6">
        {/* Desktop Category Rail */}
        <aside className="hidden lg:block w-60 shrink-0 bg-card border border-subtle rounded-xl p-3 max-h-[72vh] overflow-y-auto">
          <div className="px-2.5 py-1.5 text-xs font-semibold text-strong border-b border-subtle mb-2 flex items-center justify-between">
            <span>Categories</span>
            <span className="font-mono text-muted tabular-nums">{categories.length}</span>
          </div>
          <div className="space-y-0.5">
            <button
              onClick={() => {
                setSelectedCategory('All');
                setActivePreset('all');
              }}
              className={`w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-xs transition-colors ${
                selectedCategory === 'All' && activePreset === 'all'
                  ? 'bg-primary text-inverted font-semibold'
                  : 'text-base-text hover:bg-hover'
              }`}
            >
              <span className="truncate">All Categories</span>
              <span className="font-mono tabular-nums opacity-80 shrink-0">{FORTIX_DATASET.length}</span>
            </button>
            {categories.map(([cat, count]) => {
              const isSelected = selectedCategory === cat;
              return (
                <button
                  key={cat}
                  onClick={() => {
                    setSelectedCategory(cat);
                    setActivePreset('all');
                  }}
                  className={`w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-xs transition-colors ${
                    isSelected
                      ? 'bg-primary text-inverted font-semibold'
                      : 'text-base-text hover:bg-hover'
                  }`}
                >
                  <span className="truncate text-left">{cat}</span>
                  <span className="font-mono tabular-nums opacity-80 shrink-0">{count}</span>
                </button>
              );
            })}
          </div>
        </aside>

        {/* Results Column */}
        <div className="flex-1 min-w-0 w-full space-y-4">
          {/* Result Count & Top Pagination */}
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
            <div className="tabular-nums">
              {filteredItems.length === 0 ? (
                <span>0 matching APIs</span>
              ) : (
                <span>
                  Showing{' '}
                  <strong className="text-strong font-mono">
                    {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, filteredItems.length)}
                  </strong>{' '}
                  of <strong className="text-strong font-mono">{filteredItems.length}</strong> APIs
                  {selectedCategory !== 'All' ? ` in ${selectedCategory}` : ''}
                </span>
              )}
            </div>

            {totalPages > 1 && (
              <div className="flex items-center gap-2 tabular-nums">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={safePage <= 1}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-subtle bg-card text-strong disabled:opacity-40 hover:bg-hover transition-colors whitespace-nowrap shrink-0"
                >
                  <ChevronLeft size={14} />
                  Prev
                </button>
                <span className="font-mono text-muted px-1">
                  Page {safePage} / {totalPages}
                </span>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={safePage >= totalPages}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-subtle bg-card text-strong disabled:opacity-40 hover:bg-hover transition-colors whitespace-nowrap shrink-0"
                >
                  Next
                  <ChevronRight size={14} />
                </button>
              </div>
            )}
          </div>

          {/* Empty State */}
          {filteredItems.length === 0 ? (
            <div className="bg-card border border-subtle rounded-xl p-10 text-center space-y-3">
              <p className="text-base font-semibold text-strong">No public APIs match your current filters</p>
              <p className="text-sm text-muted max-w-md mx-auto">
                Try broadening your search terms, switching to All Categories, or clearing authentication and CORS constraints.
              </p>
              <div className="pt-2">
                <button
                  onClick={resetAllFilters}
                  className="px-4 py-2 bg-primary text-inverted text-xs font-semibold rounded-lg hover:opacity-90 transition-opacity whitespace-nowrap shrink-0"
                >
                  Show All {FORTIX_DATASET.length} APIs
                </button>
              </div>
            </div>
          ) : (
            /* API Grid */
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {paginatedItems.map((item) => {
                const isFav = favorites.has(item.id);
                const isCopied = copiedId === item.id;
                const isImporting = importingId === item.id;
                const isImported = importedIds.has(item.id);
                const safePrimaryHref = getSafeExternalHref(item.url);
                const safeDocsHref = getSafeExternalHref(item.docsUrl);
                const httpsSupported = Boolean(safePrimaryHref && safePrimaryHref.startsWith('https://'));
                const corsSupported = isCorsItem(item);
                const host = getHostname(item.url);
                const hasSeparateDocs = Boolean(safeDocsHref && safeDocsHref !== safePrimaryHref);

                return (
                  <article
                    key={item.id}
                    className="bg-card border border-subtle rounded-xl p-5 flex flex-col justify-between gap-4 hover:border-strong transition-colors"
                  >
                    <div className="space-y-2">
                      {/* Title & Bookmark */}
                      <div className="flex items-start justify-between gap-3">
                        {safePrimaryHref ? (
                          <a
                            href={safePrimaryHref}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="group inline-flex items-center gap-1.5 text-base font-semibold text-strong hover:text-primary transition-colors min-w-0"
                          >
                            <span className="truncate">{item.name}</span>
                            <ArrowUpRight
                              size={15}
                              className="text-muted group-hover:text-primary transition-colors shrink-0"
                            />
                          </a>
                        ) : (
                          <span className="text-base font-semibold text-strong truncate">{item.name}</span>
                        )}

                        <button
                          onClick={() => toggleFavorite(item.id)}
                          aria-label={isFav ? `Remove ${item.name} from saved` : `Save ${item.name}`}
                          title={isFav ? 'Saved' : 'Save API'}
                          className={`p-1.5 rounded-lg transition-colors shrink-0 ${
                            isFav ? 'text-primary bg-primary/10' : 'text-muted hover:text-strong hover:bg-hover'
                          }`}
                        >
                          <Bookmark size={15} fill={isFav ? 'currentColor' : 'none'} />
                        </button>
                      </div>

                      {/* Unboxed Metadata Line (Zero-Pill Discipline) */}
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted">
                        <span className="text-strong font-medium">{item.category}</span>
                        <span aria-hidden="true">·</span>
                        <span>{getAuthLabel(item.authType)}</span>
                        <span aria-hidden="true">·</span>
                        <span>{httpsSupported ? 'HTTPS' : 'HTTP'}</span>
                        {corsSupported && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>CORS Ready</span>
                          </>
                        )}
                        <span aria-hidden="true">·</span>
                        <span className="font-mono truncate max-w-[180px]">{host}</span>
                      </div>

                      {/* Description */}
                      <p className="text-sm text-base-text leading-relaxed line-clamp-2 pt-0.5">
                        {item.description}
                      </p>
                    </div>

                    {/* Action Bar */}
                    <div className="pt-3 border-t border-subtle flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        {safePrimaryHref && (
                          <a
                            href={safePrimaryHref}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-primary text-inverted text-xs font-semibold rounded-lg hover:opacity-90 transition-opacity whitespace-nowrap shrink-0"
                          >
                            <span>Open API Page</span>
                            <ExternalLink size={13} />
                          </a>
                        )}

                        {hasSeparateDocs && safeDocsHref && (
                          <a
                            href={safeDocsHref}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-muted hover:text-strong bg-base border border-subtle rounded-lg transition-colors whitespace-nowrap shrink-0"
                          >
                            <span>Docs</span>
                            <ExternalLink size={12} />
                          </a>
                        )}
                      </div>

                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => handleCopyUrl(item)}
                          title="Copy API URL"
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-muted hover:text-strong bg-base border border-subtle rounded-lg transition-colors whitespace-nowrap shrink-0"
                        >
                          {isCopied ? <Check size={13} className="text-emerald-500" /> : <Copy size={13} />}
                          <span>{isCopied ? 'Copied' : 'Copy URL'}</span>
                        </button>

                        {httpsSupported && (
                          <button
                            onClick={() => setPendingRouteItem(item)}
                            disabled={isImporting || isImported}
                            title="Review and register this endpoint as an upstream route in your active FortiX project"
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-strong bg-hover hover:bg-hover-strong border border-subtle rounded-lg transition-colors disabled:opacity-60 whitespace-nowrap shrink-0"
                          >
                            {isImported ? (
                              <>
                                <Check size={13} className="text-emerald-500" />
                                <span>Added</span>
                              </>
                            ) : (
                              <>
                                <Plus size={13} />
                                <span>{isImporting ? 'Adding...' : 'Add Route'}</span>
                              </>
                            )}
                          </button>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}

          {/* Bottom Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between pt-4 border-t border-subtle text-xs text-muted tabular-nums">
              <span>
                Page {safePage} of {totalPages}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    setPage((p) => Math.max(1, p - 1));
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                  disabled={safePage <= 1}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-subtle bg-card text-strong disabled:opacity-40 hover:bg-hover transition-colors whitespace-nowrap shrink-0"
                >
                  <ChevronLeft size={14} />
                  Previous
                </button>
                <button
                  onClick={() => {
                    setPage((p) => Math.min(totalPages, p + 1));
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                  disabled={safePage >= totalPages}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-subtle bg-card text-strong disabled:opacity-40 hover:bg-hover transition-colors whitespace-nowrap shrink-0"
                >
                  Next
                  <ChevronRight size={14} />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Explicit Route Registration Confirmation Modal */}
      {pendingRouteItem && (
        <div
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4"
          onClick={() => setPendingRouteItem(null)}
        >
          <div
            className="bg-surface border border-subtle rounded-xl max-w-lg w-full p-6 space-y-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="space-y-1">
              <h3 className="text-lg font-semibold text-strong">Confirm Upstream Route Registration</h3>
              <p className="text-xs text-muted leading-relaxed">
                Public directory entries are third-party discovery links. Review the destination and gateway permissions before registering this endpoint in{' '}
                <strong className="text-strong">{currentProject?.name || 'your active project'}</strong>.
              </p>
            </div>

            <div className="bg-base border border-subtle rounded-lg p-3.5 space-y-2 text-xs">
              <div>
                <span className="text-muted">Provider:</span>{' '}
                <span className="font-semibold text-strong">{pendingRouteItem.name}</span>{' '}
                <span className="text-muted">· {pendingRouteItem.category}</span>
              </div>
              <div>
                <span className="text-muted">Gateway Path:</span>{' '}
                <span className="font-mono text-strong">/api/public/{toRouteSlug(pendingRouteItem.name)}</span>
              </div>
              <div className="break-all">
                <span className="text-muted">Target Upstream URL:</span>{' '}
                <span className="font-mono text-strong">{pendingRouteItem.url}</span>
              </div>
            </div>

            <p className="text-xs text-muted leading-relaxed">
              Outbound requests through this route enforce FortiX API-key authentication, server-side SSRF validation, WAF inspection, and project rate limits. Do not run active fault-injection or load tests against third-party public APIs without explicit authorization from the provider.
            </p>

            <div className="flex items-center justify-end gap-2.5 pt-2">
              <button
                onClick={() => setPendingRouteItem(null)}
                className="px-4 py-2 text-xs font-medium text-muted hover:text-strong bg-base border border-subtle rounded-lg transition-colors whitespace-nowrap shrink-0"
              >
                Cancel
              </button>
              <button
                onClick={() => confirmImportToGateway(pendingRouteItem)}
                className="px-4 py-2 text-xs font-semibold bg-primary text-inverted rounded-lg hover:opacity-90 transition-opacity whitespace-nowrap shrink-0"
              >
                Confirm & Register Route
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
