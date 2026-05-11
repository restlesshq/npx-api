import { describe, it, expect } from 'vitest';
import {
  generate, parse, readBlockFields, canonicalizeInitArg, setProjectId,
} from '../lib/sdk-writers/javascript.js';

function ctxWith(overrides = {}) {
  return {
    keyDelivery: null,
    apiKey: null,
    envLoader: { mode: 'none', evidence: 'none' },
    ...overrides,
  };
}

describe('generate', () => {
  it('emits a no-arg CJS init when no env loader is present, with no sentinel comments', () => {
    const out = generate(ctxWith({ keyDelivery: 'manual' }), {
      module: 'cjs', framework: 'express', appVar: 'app',
      credentialExpr: 'req.headers.authorization', projectIdExpr: null,
    });
    expect(out).toContain("const sdk = require('@restlessai/sdk')();");
    expect(out).toContain('app.use(sdk.setup(');
    expect(out).toContain('sdk.mask(req.headers.authorization)');
    expect(out).not.toContain('restless-sdk-start');
    expect(out).not.toContain('restless-sdk-end');
    expect(out).not.toContain('managed by');
  });

  it('uses process.env.RESTLESS_KEY when an env loader is detected', () => {
    const out = generate(
      ctxWith({ keyDelivery: 'env', envLoader: { mode: 'dotenv', evidence: 'dotenv installed' } }),
      { module: 'cjs', framework: 'express', appVar: 'app', credentialExpr: 'req.headers["x-api-key"]' },
    );
    expect(out).toContain('require(\'@restlessai/sdk\')(process.env.RESTLESS_KEY)');
  });

  it('inlines the literal key when keyDelivery is inline, with a TODO comment', () => {
    const out = generate(
      ctxWith({ keyDelivery: 'inline', apiKey: 'rdme_abc' }),
      { module: 'cjs', framework: 'express', appVar: 'app', credentialExpr: 'auth' },
    );
    expect(out).toContain('TODO: move this out of the codebase before committing');
    expect(out).toContain("require('@restlessai/sdk')(\"rdme_abc\")");
  });

  it('emits ESM imports when module is esm', () => {
    const out = generate(ctxWith({ keyDelivery: 'manual' }), {
      module: 'esm', framework: 'express', appVar: 'app', credentialExpr: 'auth',
    });
    expect(out).toContain("import restless from '@restlessai/sdk';");
    expect(out).toContain('const sdk = restless();');
  });

  it('uses fastify.register for fastify framework', () => {
    const out = generate(ctxWith({ keyDelivery: 'manual' }), {
      module: 'cjs', framework: 'fastify', appVar: 'fastify', credentialExpr: 'auth',
    });
    expect(out).toContain('fastify.register(sdk.setup(');
  });

  it('includes project.id when an expression is provided', () => {
    const out = generate(ctxWith({ keyDelivery: 'manual' }), {
      module: 'cjs', framework: 'express', appVar: 'app', credentialExpr: 'auth',
      projectIdExpr: 'user.workspaceId',
    });
    expect(out).toContain('project: { id: user.workspaceId }');
  });

  it('omits the project block when no projectIdExpr is provided', () => {
    const out = generate(ctxWith({ keyDelivery: 'manual' }), {
      module: 'cjs', framework: 'express', appVar: 'app', credentialExpr: 'auth',
    });
    expect(out).not.toContain('project: {');
  });
});

describe('parse', () => {
  it('returns a wrapper when the file references @restlessai/sdk', () => {
    const content = "const sdk = require('@restlessai/sdk')();\napp.use(sdk.setup(req => ({ apiKey: sdk.mask(req.headers.authorization) })));\n";
    const found = parse(content);
    expect(found).not.toBeNull();
    expect(found.block).toBe(content);
    expect(found.startIdx).toBe(0);
    expect(found.endIdx).toBe(content.length);
  });

  it('returns null when the file has no SDK reference', () => {
    expect(parse('const x = 1;\n')).toBeNull();
    expect(parse('')).toBeNull();
    expect(parse(null)).toBeNull();
  });
});

describe('readBlockFields', () => {
  it('reads a literal key out of a CJS init line', () => {
    const content = `const sdk = require('@restlessai/sdk')("rdme_abc");\n`;
    const r = readBlockFields(content);
    expect(r.initArgForm).toBe('literal');
    expect(r.initArgValue).toBe('rdme_abc');
  });

  it('reads an env-ref init line', () => {
    const content = `const sdk = require('@restlessai/sdk')(process.env.RESTLESS_KEY);\n`;
    const r = readBlockFields(content);
    expect(r.initArgForm).toBe('env-ref');
    expect(r.initArgValue).toBe('RESTLESS_KEY');
  });

  it('reads a no-arg init line', () => {
    const content = `const sdk = require('@restlessai/sdk')();\n`;
    const r = readBlockFields(content);
    expect(r.initArgForm).toBe('no-arg');
  });

  it('extracts the credential expression and project.id expression', () => {
    const content = `const sdk = require('@restlessai/sdk')();
app.use(sdk.setup((req) => ({
  apiKey: sdk.mask(req.headers['x-api-key']),
  project: { id: workspace.id },
})));`;
    const r = readBlockFields(content);
    expect(r.credentialExpr).toBe("req.headers['x-api-key']");
    expect(r.projectIdExpr).toBe('workspace.id');
  });
});

describe('canonicalizeInitArg', () => {
  // The AI wrote a placeholder; the CLI must replace it deterministically
  // based on ctx.sdkLineSpec. This is the bug-class fix: CLI authoritatively
  // owns the init line, AI's auth/project work in the callback is preserved.
  const placeholderBlock = `const sdk = require('@restlessai/sdk')(process.env.RESTLESS_KEY);
app.use(sdk.setup((req) => ({
  apiKey: sdk.mask(req.headers['x-api-key']),
  project: { id: workspace.id },
})));`;

  it('swaps placeholder for the literal key in inline mode', () => {
    const out = canonicalizeInitArg(placeholderBlock, ctxWith({ keyDelivery: 'inline', apiKey: 'rdme_abc' }));
    expect(out).toContain("require('@restlessai/sdk')(\"rdme_abc\")");
    expect(out).toContain('TODO: move this out of the codebase before committing');
    // Auth + project preserved.
    expect(out).toContain("sdk.mask(req.headers['x-api-key'])");
    expect(out).toContain('project: { id: workspace.id }');
  });

  it('swaps placeholder for no-arg form when no env loader and not inline', () => {
    const out = canonicalizeInitArg(placeholderBlock, ctxWith({ keyDelivery: 'manual' }));
    expect(out).toContain("require('@restlessai/sdk')()");
    expect(out).not.toContain('process.env.RESTLESS_KEY');
    expect(out).not.toContain('TODO: move this out of the codebase');
  });

  it('keeps process.env.RESTLESS_KEY when env loader is present', () => {
    const out = canonicalizeInitArg(placeholderBlock, ctxWith({ keyDelivery: 'env', envLoader: { mode: 'dotenv', evidence: 'dotenv installed' } }));
    expect(out).toContain('require(\'@restlessai/sdk\')(process.env.RESTLESS_KEY)');
  });

  it('is idempotent - running twice in inline mode produces the same content', () => {
    const ctx = ctxWith({ keyDelivery: 'inline', apiKey: 'rdme_abc' });
    const once = canonicalizeInitArg(placeholderBlock, ctx);
    const twice = canonicalizeInitArg(once, ctx);
    expect(twice).toBe(once);
    // No double-TODO.
    expect(twice.match(/TODO: move this out of the codebase/g)).toHaveLength(1);
  });

  it('strips a stale TODO when switching from inline mode to env mode', () => {
    const inlineBlock = canonicalizeInitArg(placeholderBlock, ctxWith({ keyDelivery: 'inline', apiKey: 'rdme_abc' }));
    const envBlock = canonicalizeInitArg(inlineBlock, ctxWith({ keyDelivery: 'env', envLoader: { mode: 'dotenv', evidence: 'dotenv installed' } }));
    expect(envBlock).not.toContain('TODO: move this out of the codebase');
    expect(envBlock).toContain('process.env.RESTLESS_KEY');
  });

  it('rewrites an ESM init call', () => {
    const esmBlock = `import restless from '@restlessai/sdk';
const sdk = restless(process.env.RESTLESS_KEY);
app.use(sdk.setup((req) => ({ apiKey: sdk.mask(req.headers.authorization) })));`;
    const out = canonicalizeInitArg(esmBlock, ctxWith({ keyDelivery: 'inline', apiKey: 'rdme_abc' }));
    expect(out).toContain('const sdk = restless("rdme_abc");');
  });

  it('returns content unchanged when there is no SDK reference', () => {
    expect(canonicalizeInitArg('const x = 1;\n', ctxWith({ keyDelivery: 'inline', apiKey: 'rdme_abc' })))
      .toBe('const x = 1;\n');
  });
});

describe('setProjectId', () => {
  it('inserts project.id after apiKey when the block has none', () => {
    const initial = generate(ctxWith({ keyDelivery: 'manual' }), {
      module: 'cjs', framework: 'express', appVar: 'app', credentialExpr: 'auth',
    });
    const content = `const app = require('express')();\n${initial}`;
    const next = setProjectId(content, 'user.workspaceId');
    expect(next).toContain('project: { id: user.workspaceId },');
    // apiKey line still present, no duplicate project lines.
    expect(next.match(/apiKey:\s*sdk\.mask/g)).toHaveLength(1);
    expect(next.match(/project\s*:\s*\{\s*id:/g)).toHaveLength(1);
  });

  it('replaces an existing risky project.id in place', () => {
    const initial = generate(ctxWith({ keyDelivery: 'manual' }), {
      module: 'cjs', framework: 'express', appVar: 'app',
      credentialExpr: 'auth', projectIdExpr: 'req.headers.authorization',
    });
    const content = `const app = require('express')();\n${initial}`;
    const next = setProjectId(content, 'user.id');
    expect(next).toContain('project: { id: user.id }');
    expect(next).not.toContain('req.headers.authorization');
  });

  it('preserves the apiKey line indentation when inserting', () => {
    const initial = generate(ctxWith({ keyDelivery: 'manual' }), {
      module: 'cjs', framework: 'express', appVar: 'app', credentialExpr: 'auth',
    });
    const next = setProjectId(initial, 'user.id');
    // The new project line should share the same leading whitespace as apiKey.
    const apiKeyIndent = next.match(/^([ \t]*)apiKey\s*:/m)[1];
    const projectIndent = next.match(/^([ \t]*)project\s*:/m)[1];
    expect(projectIndent).toBe(apiKeyIndent);
  });

  it('returns content unchanged when there is no managed block', () => {
    const content = `const x = 1;\n`;
    expect(setProjectId(content, 'user.id')).toBe(content);
  });

  it('returns content unchanged when the expression is empty or whitespace', () => {
    const initial = generate(ctxWith({ keyDelivery: 'manual' }), {
      module: 'cjs', framework: 'express', appVar: 'app', credentialExpr: 'auth',
    });
    expect(setProjectId(initial, '')).toBe(initial);
    expect(setProjectId(initial, '   ')).toBe(initial);
  });
});

