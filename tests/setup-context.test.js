import { describe, it, expect, vi } from 'vitest';
import { createSetupContext, getSdkLineSpec, redactSetupContext } from '../lib/setup-context.js';

// Env detection is a writer method now, so the stub goes on the registry
// rather than on a separate envLoader module. Stubbed because these cases are
// about the context's own shape, not about reading a real project tree.
vi.mock('../lib/sdk-writers/index.js', () => ({
  getSdkWriter: () => ({
    detectEnvLoader: () => ({ mode: 'none', evidence: 'no env loader detected' }),
  }),
}));

describe('createSetupContext', () => {
  it('initializes with detected and provided fields, leaves account fields null', () => {
    const ctx = createSetupContext({
      packageDir: '/p', rootDir: '/r', apiRootDir: '.', installDir: '/p',
      apiDir: '/p', language: 'javascript', framework: 'express', aiTool: 'Claude Code',
    });
    expect(ctx.language).toBe('javascript');
    expect(ctx.envLoader).toEqual({ mode: 'none', evidence: 'no env loader detected' });
    expect(ctx.apiKey).toBeNull();
    expect(ctx.keyDelivery).toBeNull();
  });
});

describe('getSdkLineSpec', () => {
  const base = { envLoader: { mode: 'none', evidence: 'none' } };

  it('returns literal form with the actual key when keyDelivery is inline', () => {
    expect(getSdkLineSpec({ ...base, keyDelivery: 'inline', apiKey: 'rdme_abc' }))
      .toEqual({ form: 'literal', value: 'rdme_abc' });
  });

  it('returns env-ref form when an env loader is present', () => {
    expect(getSdkLineSpec({ keyDelivery: 'env', apiKey: 'rdme_abc', envLoader: { mode: 'dotenv', evidence: 'dotenv installed' } }))
      .toEqual({ form: 'env-ref', value: 'RESTLESS_KEY' });
  });

  it('returns no-arg form when neither inline nor env loader applies', () => {
    expect(getSdkLineSpec({ ...base, keyDelivery: 'manual', apiKey: 'rdme_abc' }))
      .toEqual({ form: 'no-arg' });
  });

  it('inline beats env loader (user choice wins)', () => {
    expect(getSdkLineSpec({ keyDelivery: 'inline', apiKey: 'rdme_abc', envLoader: { mode: 'dotenv', evidence: 'dotenv installed' } }))
      .toEqual({ form: 'literal', value: 'rdme_abc' });
  });
});

describe('redactSetupContext', () => {
  it('truncates the apiKey and removes the setupKey, keeps other fields', () => {
    const ctx = createSetupContext({
      packageDir: '/p', rootDir: '/r', apiRootDir: '.', installDir: '/p',
      apiDir: '/p', language: 'javascript', framework: 'express', aiTool: 'Claude Code',
    });
    ctx.apiKey = 'rdme_abcdef1234567890tail';
    ctx.setupKey = 'super-secret-token';
    ctx.keyDelivery = 'inline';
    const r = redactSetupContext(ctx);
    expect(r.apiKey).toBe('rdme_abc...tail');
    expect(r.setupKey).toBe('<redacted>');
    expect(r.framework).toBe('express');
    expect(r.sdkLineSpec).toEqual({ form: 'literal', value: 'rdme_abcdef1234567890tail' });
  });
});
