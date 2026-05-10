import { describe, it, expect } from 'vitest';
import {
  generate, parse, readBlockFields, replaceInContent, canonicalizeInitArg,
  BLOCK_START, BLOCK_END,
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
  it('emits a sentinel-bracketed block with a no-arg CJS init when no env loader', () => {
    const out = generate(ctxWith({ keyDelivery: 'manual' }), {
      module: 'cjs', framework: 'express', appVar: 'app',
      credentialExpr: 'req.headers.authorization', projectIdExpr: null,
    });
    expect(out).toContain(BLOCK_START);
    expect(out).toContain(BLOCK_END);
    expect(out).toContain("const sdk = require('@restlessai/sdk')();");
    expect(out).toContain('app.use(sdk.setup(');
    expect(out).toContain('sdk.mask(req.headers.authorization)');
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
  it('finds a sentinel-bracketed block', () => {
    const content = `// imports\n${BLOCK_START}\nconst sdk = require('@restlessai/sdk')();\napp.use(sdk.setup(req => ({ apiKey: sdk.mask(req.headers.authorization) })));\n${BLOCK_END}\n// rest`;
    const found = parse(content);
    expect(found).not.toBeNull();
    expect(found.block).toContain(BLOCK_START);
    expect(found.block).toContain(BLOCK_END);
  });

  it('returns null when no block exists', () => {
    expect(parse("const x = require('@restlessai/sdk')();\n")).toBeNull();
    expect(parse('')).toBeNull();
  });

  it('returns null when start marker is present but end marker is missing', () => {
    expect(parse(`${BLOCK_START}\nconst sdk = require('@restlessai/sdk')();\n`)).toBeNull();
  });
});

describe('readBlockFields', () => {
  it('reads a literal key out of a CJS init line', () => {
    const block = `${BLOCK_START}\nconst sdk = require('@restlessai/sdk')("rdme_abc");\n${BLOCK_END}`;
    const r = readBlockFields(block);
    expect(r.initArgForm).toBe('literal');
    expect(r.initArgValue).toBe('rdme_abc');
  });

  it('reads an env-ref init line', () => {
    const block = `${BLOCK_START}\nconst sdk = require('@restlessai/sdk')(process.env.RESTLESS_KEY);\n${BLOCK_END}`;
    const r = readBlockFields(block);
    expect(r.initArgForm).toBe('env-ref');
    expect(r.initArgValue).toBe('RESTLESS_KEY');
  });

  it('reads a no-arg init line', () => {
    const block = `${BLOCK_START}\nconst sdk = require('@restlessai/sdk')();\n${BLOCK_END}`;
    const r = readBlockFields(block);
    expect(r.initArgForm).toBe('no-arg');
  });

  it('extracts the credential expression and project.id expression', () => {
    const block = `${BLOCK_START}
const sdk = require('@restlessai/sdk')();
app.use(sdk.setup((req) => ({
  apiKey: sdk.mask(req.headers['x-api-key']),
  project: { id: workspace.id },
})));
${BLOCK_END}`;
    const r = readBlockFields(block);
    expect(r.credentialExpr).toBe("req.headers['x-api-key']");
    expect(r.projectIdExpr).toBe('workspace.id');
  });
});

describe('canonicalizeInitArg', () => {
  // The AI wrote a placeholder; the CLI must replace it deterministically
  // based on ctx.sdkLineSpec. This is the bug-class fix: CLI authoritatively
  // owns the init line, AI's auth/project work inside the block is preserved.
  const placeholderBlock = `${BLOCK_START}
const sdk = require('@restlessai/sdk')(process.env.RESTLESS_KEY);
app.use(sdk.setup((req) => ({
  apiKey: sdk.mask(req.headers['x-api-key']),
  project: { id: workspace.id },
})));
${BLOCK_END}`;

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
    const esmBlock = `${BLOCK_START}
import restless from '@restlessai/sdk';
const sdk = restless(process.env.RESTLESS_KEY);
app.use(sdk.setup((req) => ({ apiKey: sdk.mask(req.headers.authorization) })));
${BLOCK_END}`;
    const out = canonicalizeInitArg(esmBlock, ctxWith({ keyDelivery: 'inline', apiKey: 'rdme_abc' }));
    expect(out).toContain('const sdk = restless("rdme_abc");');
  });

  it('returns content unchanged when there is no block', () => {
    expect(canonicalizeInitArg('const x = 1;\n', ctxWith({ keyDelivery: 'inline', apiKey: 'rdme_abc' })))
      .toBe('const x = 1;\n');
  });
});

describe('replaceInContent', () => {
  it('replaces an existing block with a freshly generated one', () => {
    const initialBlock = generate(ctxWith({ keyDelivery: 'manual' }), {
      module: 'cjs', framework: 'express', appVar: 'app', credentialExpr: 'auth',
    });
    const content = `// header\n${initialBlock}// trailer\n`;
    const next = replaceInContent(
      content,
      ctxWith({ keyDelivery: 'inline', apiKey: 'rdme_abc' }),
      { module: 'cjs', framework: 'express', appVar: 'app', credentialExpr: 'auth' },
    );
    expect(next).toContain('"rdme_abc"');
    expect(next).toContain('TODO: move this out of the codebase');
    expect(next).toContain('// header');
    expect(next).toContain('// trailer');
    // Only one block - we replaced, not duplicated.
    expect(next.match(/restless-sdk-start/g)).toHaveLength(1);
  });

  it('returns content unchanged when no existing block is present', () => {
    const content = `const x = 1;\n`;
    const next = replaceInContent(content, ctxWith({ keyDelivery: 'manual' }), {
      module: 'cjs', framework: 'express', appVar: 'app', credentialExpr: 'auth',
    });
    expect(next).toBe(content);
  });
});
