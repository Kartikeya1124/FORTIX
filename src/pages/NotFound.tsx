import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Compass, ArrowLeft, Server } from 'lucide-react';

export default function NotFound({ isAuthenticated = true }: { isAuthenticated?: boolean }) {
  const location = useLocation();

  return (
    <div className="min-h-[70vh] w-full flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-lg rounded-2xl bg-surface border border-subtle p-8 space-y-6">
        <div className="flex items-center justify-between border-b border-subtle pb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary/15 border border-primary/30 flex items-center justify-center text-primary">
              <Compass size={20} />
            </div>
            <div>
              <div className="text-xs font-mono uppercase tracking-wider text-primary font-bold">
                HTTP 404 · Unmatched Route
              </div>
              <h2 className="text-xl font-bold text-strong tracking-tight">
                Page not found
              </h2>
            </div>
          </div>
          <span className="font-mono text-2xl font-bold text-muted tabular-nums">404</span>
        </div>

        <div className="space-y-3 text-sm text-muted leading-relaxed">
          <p>
            The requested control-plane path does not match any active FortiX console view.
          </p>
          <div className="rounded-xl bg-base border border-subtle px-3.5 py-2.5 font-mono text-xs text-strong break-all">
            {location.pathname}
            {location.search}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 pt-2">
          <Link
            to="/"
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-primary hover:bg-primary-hover text-zinc-950 font-semibold text-xs transition-colors whitespace-nowrap"
          >
            <ArrowLeft size={14} />
            <span>{isAuthenticated ? 'Return to Dashboard' : 'Go to Sign In'}</span>
          </Link>
          {isAuthenticated && (
            <Link
              to="/apis"
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-base hover:bg-hover border border-subtle text-strong font-semibold text-xs transition-colors whitespace-nowrap"
            >
              <Server size={14} />
              <span>Protected APIs</span>
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
