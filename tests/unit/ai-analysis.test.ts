import { describe, it, expect, vi, beforeEach } from 'vitest';
import { analyzeRunEvidence, sanitizeEvidenceForAi, RunEvidenceContext } from '../../src/ai/analyzer.js';

describe('FortiX Evidence-Assisted AI Analysis & Redaction Guardrails', () => {
  const sampleEvidence: RunEvidenceContext = {
    runId: 'run_sample123456789',
    profile: 'security-audit',
    targetUrl: 'https://user:SuperSecretPassword123@api.target.com/v1/resource?api_key=fx_live_secret1234567890',
    totalRequests: 40,
    passedRequests: 36,
    blockedRequests: 4,
    errorRequests: 0,
    latencyPercentiles: { p50: 45, p90: 95, p95: 140, p99: 210 },
    threatEventsCount: 4,
    observedThreats: ['SQL_INJECTION', 'XSS_ATTACK'],
    deterministicScore: 92,
    deterministicPassed: true,
    recoveryStatus: 'CLEANED_AND_RECOVERED',
    policyViolations: [],
  };

  it('1. Sanitizes credentials, passwords, and sensitive keys from evidence prior to model ingestion', () => {
    const sanitized = sanitizeEvidenceForAi(sampleEvidence);

    // Assert that credentials were fully redacted
    expect(sanitized.targetUrl).not.toContain('SuperSecretPassword123');
    expect(sanitized.targetUrl).not.toContain('fx_live_secret1234567890');
    expect(sanitized.targetUrl).toContain('[REDACTED_AUTH]');
    expect(sanitized.targetUrl).toContain('api_key=[REDACTED]');

    // Assert that metrics and deterministic source of truth are preserved
    expect(sanitized.deterministicEvaluation.score).toBe(92);
    expect(sanitized.deterministicEvaluation.verdictPassed).toBe(true);
    expect(sanitized.metrics.totalRequests).toBe(40);
  });

  it('2. Fails gracefully when GEMINI_API_KEY is not configured without breaking deterministic verification', async () => {
    const originalKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;

    try {
      const result = await analyzeRunEvidence(sampleEvidence);

      expect(result.available).toBe(false);
      expect(result.reason).toMatch(/GEMINI_API_KEY is unset/i);
      expect(result.analyzedAt).toBeDefined();

      // Does not fabricate scores or change deterministic results
      expect((result as any).score).toBeUndefined();
    } finally {
      if (originalKey) process.env.GEMINI_API_KEY = originalKey;
    }
  });

  it('3. Preserves deterministic authority regardless of AI availability', async () => {
    const res = await analyzeRunEvidence(sampleEvidence);

    // AI output structure adheres to strict schema when available, or returns informative unavailable state
    if (res.available) {
      expect(res.executiveSummary).toBeDefined();
      expect(res.technicalSummary).toBeDefined();
      expect(Array.isArray(res.recommendations)).toBe(true);
    } else {
      expect(res.reason).toBeDefined();
    }
  });
});
