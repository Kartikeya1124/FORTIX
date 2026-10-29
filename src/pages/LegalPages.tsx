import React from 'react';
import { Link } from 'react-router-dom';
import { Shield, FileText, ArrowLeft } from 'lucide-react';

export function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen w-full bg-[#090b10] text-zinc-100 px-4 py-10">
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="flex items-center justify-between border-b border-white/10 pb-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-primary text-zinc-950 font-bold flex items-center justify-center text-sm">
              FX
            </div>
            <div>
              <h1 className="text-xl font-bold text-white tracking-tight">FortiX Privacy Policy</h1>
              <p className="text-xs text-zinc-400 font-mono">Effective Date: October 29, 2026</p>
            </div>
          </div>
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#131622] hover:bg-[#1c2133] border border-white/15 text-xs font-semibold text-zinc-200 transition-colors whitespace-nowrap"
          >
            <ArrowLeft size={14} />
            <span>Back to FortiX</span>
          </Link>
        </div>

        <div className="rounded-2xl bg-[#131622] border border-white/15 p-6 sm:p-8 space-y-6 text-sm text-zinc-300 leading-relaxed">
          <section className="space-y-2">
            <h2 className="text-base font-bold text-white flex items-center gap-2">
              <Shield size={16} className="text-primary" />
              <span>1. Information FortiX Collects</span>
            </h2>
            <p>
              FortiX collects only operational data required to authenticate operators, isolate workspaces, enforce gateway security policies, and record resilience verification evidence:
            </p>
            <ul className="list-disc pl-5 space-y-1 text-zinc-400 text-xs sm:text-sm">
              <li><strong>Account Credentials:</strong> Operator email address, bcrypt password hash, role assignment, and email verification state. Plaintext passwords are never persisted.</li>
              <li><strong>Session & CSRF State:</strong> Short-lived <code className="font-mono text-zinc-200">HttpOnly</code> session cookies and anti-CSRF tokens. Authentication tokens are never stored in browser <code className="font-mono text-zinc-200">localStorage</code>.</li>
              <li><strong>Workspace Configuration:</strong> Project names, upstream route URLs, per-route rate-limit/WAF/SSRF policies, and SHA-256/bcrypt hashed gateway API key prefixes. Raw gateway API keys are displayed once at creation and never stored in plaintext.</li>
              <li><strong>Gateway & Experiment Telemetry:</strong> Request latency, HTTP status codes, blocked WAF/SSRF threat metadata, experiment state transitions, and generated verification artifacts.</li>
            </ul>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-bold text-white">2. How Data Is Stored & Redacted</h2>
            <p className="text-xs sm:text-sm text-zinc-400">
              Persistent deployments store relational records in PostgreSQL and ephemeral rate-limit/revocation state in Redis over TLS. Structured server logs automatically redact <code className="font-mono text-zinc-200">Authorization</code> headers, session cookies, <code className="font-mono text-zinc-200">X-API-Key</code> headers, passwords, and webhook secrets before output.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-bold text-white">3. Retention & Account Deletion</h2>
            <p className="text-xs sm:text-sm text-zinc-400">
              Authenticated operators may permanently delete their account at any time from <strong>Settings → Account → Delete Account</strong>. Account deletion immediately revokes active sessions and gateway API keys, closes active WebSocket subscriptions, and cascades deletion across owned organizations, projects, routes, policies, experiments, and action tokens.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-bold text-white">4. Contact & Security Disclosures</h2>
            <p className="text-xs sm:text-sm text-zinc-400">
              For privacy requests or vulnerability disclosures regarding FortiX deployments, contact the workspace administrator responsible for your FortiX instance.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}

export function TermsOfUsePage() {
  return (
    <div className="min-h-screen w-full bg-[#090b10] text-zinc-100 px-4 py-10">
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="flex items-center justify-between border-b border-white/10 pb-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-primary text-zinc-950 font-bold flex items-center justify-center text-sm">
              FX
            </div>
            <div>
              <h1 className="text-xl font-bold text-white tracking-tight">FortiX Terms of Acceptable Use</h1>
              <p className="text-xs text-zinc-400 font-mono">Effective Date: October 29, 2026</p>
            </div>
          </div>
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#131622] hover:bg-[#1c2133] border border-white/15 text-xs font-semibold text-zinc-200 transition-colors whitespace-nowrap"
          >
            <ArrowLeft size={14} />
            <span>Back to FortiX</span>
          </Link>
        </div>

        <div className="rounded-2xl bg-[#131622] border border-white/15 p-6 sm:p-8 space-y-6 text-sm text-zinc-300 leading-relaxed">
          <section className="space-y-2">
            <h2 className="text-base font-bold text-white flex items-center gap-2">
              <FileText size={16} className="text-primary" />
              <span>1. Authorized Upstream Testing Only</span>
            </h2>
            <p className="text-xs sm:text-sm text-zinc-400">
              You may configure gateway routes, webhook targets, and resilience fault-injection experiments <strong>only against APIs and systems that you own or have explicit written authorization to test</strong>. Entries listed in the Public API Directory are provided strictly for discovery and reference; listing in the directory does not grant permission to load-test or inject faults against third-party services.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-bold text-white">2. Prohibited Conduct</h2>
            <ul className="list-disc pl-5 space-y-1 text-zinc-400 text-xs sm:text-sm">
              <li>Using FortiX proxy routes or webhooks to probe private RFC1918 networks, loopback interfaces, link-local cloud metadata endpoints, or internal infrastructure (enforced by SSRF and DNS-rebinding controls).</li>
              <li>Attempting cross-tenant access, credential stuffing, denial-of-service amplification, or unauthorized traffic relays against external endpoints.</li>
              <li>Sharing gateway API keys publicly or embedding server-side secrets in client-side code.</li>
            </ul>
          </section>

          <section className="space-y-2">
            <h2 className="text-base font-bold text-white">3. Bounded Experiment Execution & Warranties</h2>
            <p className="text-xs sm:text-sm text-zinc-400">
              Resilience experiments (latency injection, HTTP 5xx simulation, timeout bounding, and traffic bursts) operate within configured duration and concurrency caps. FortiX is provided &ldquo;as is&rdquo; without warranty of uninterrupted availability; operators remain solely responsible for upstream capacity planning and target authorization.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
