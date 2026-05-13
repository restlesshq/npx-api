import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const runAI = vi.fn();

vi.mock('../lib/ai.js', async () => {
  const actual = await vi.importActual('../lib/ai.js');
  return {
    ...actual,
    runAI: (...args) => runAI(...args),
  };
});

import verifyOwnerId from '../steps/verify-owner-id.js';

function makeDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'verify-owner-id-')));
}

function writeWired(dir, ownerLine) {
  const src = `const sdk = require('@restlessai/sdk')();
app.use(sdk.setup((req) => ({
  apiKey: sdk.mask(req.headers.authorization),
  ${ownerLine}
})));
`;
  fs.writeFileSync(path.join(dir, 'index.js'), src);
  return path.join(dir, 'index.js');
}

describe('verifyOwnerId', () => {
  let dir;
  let updates;
  beforeEach(() => {
    dir = makeDir();
    updates = [];
    runAI.mockReset();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const ctxFor = (overrides = {}) => ({
    installDir: dir, language: 'javascript', framework: 'express', aiTool: 'Claude Code', ...overrides,
  });
  const update = (msg) => updates.push(msg);

  it('skips work when no wired file is present', async () => {
    const result = await verifyOwnerId({ ctx: ctxFor(), update, setSpinner: () => {} });
    expect(result.ran).toBe(false);
    expect(result.reason).toBe('no-source');
    expect(runAI).not.toHaveBeenCalled();
  });

  it("skips AI when static analysis already flags critical (sentinel)", async () => {
    writeWired(dir, "owner: { id: 'NEEDS_CONFIGURATION' },");
    const result = await verifyOwnerId({ ctx: ctxFor(), update, setSpinner: () => {} });
    expect(result.ran).toBe(false);
    expect(result.reason).toBe('static-critical');
    expect(runAI).not.toHaveBeenCalled();
  });

  it("skips AI when static analysis already flags critical (req.body)", async () => {
    writeWired(dir, 'owner: { id: req.body.tenantId },');
    const result = await verifyOwnerId({ ctx: ctxFor(), update, setSpinner: () => {} });
    expect(result.ran).toBe(false);
    expect(result.reason).toBe('static-critical');
    expect(runAI).not.toHaveBeenCalled();
  });

  it('runs the AI when owner.id is statically ok and reports verified when AI made no change', async () => {
    writeWired(dir, 'owner: { id: req.user.workspaceId },');
    runAI.mockResolvedValue(undefined);

    const result = await verifyOwnerId({ ctx: ctxFor(), update, setSpinner: () => {} });

    expect(runAI).toHaveBeenCalledOnce();
    expect(result.ran).toBe(true);
    expect(result.changed).toBe(false);
    // UI surfaced a green check.
    const allText = updates.flatMap((u) => u.message || []).join('\n');
    expect(allText).toContain('verified');
  });

  it("downgrades to sentinel when the AI rewrites owner.id to NEEDS_CONFIGURATION", async () => {
    const file = writeWired(dir, 'owner: { id: req.user.workspaceId },');
    runAI.mockImplementation(async () => {
      // Simulate the AI deciding the field isn't actually immutable.
      const src = fs.readFileSync(file, 'utf8');
      fs.writeFileSync(
        file,
        src.replace(
          'owner: { id: req.user.workspaceId },',
          "owner: {\n    // RESTLESS_OWNER_ID_TODO: req.user.workspaceId is set from unsigned body input.\n    id: 'NEEDS_CONFIGURATION',\n  },",
        ),
      );
    });

    const result = await verifyOwnerId({ ctx: ctxFor(), update, setSpinner: () => {} });

    expect(runAI).toHaveBeenCalledOnce();
    expect(result.changed).toBe(true);
    expect(result.after.severity).toBe('critical');
    const allText = updates.flatMap((u) => u.message || []).join('\n');
    expect(allText).toMatch(/couldn't confirm|sentinel/i);
  });

  it('runs the AI on statically-warning expressions (e.g. raw header) but tolerates a no-op AI', async () => {
    writeWired(dir, "owner: { id: req.headers['x-workspace-id'] },");
    runAI.mockResolvedValue(undefined);

    const result = await verifyOwnerId({ ctx: ctxFor(), update, setSpinner: () => {} });

    expect(runAI).toHaveBeenCalledOnce();
    expect(result.changed).toBe(false);
    const allText = updates.flatMap((u) => u.message || []).join('\n');
    // The warning copy goes to the user so they know to confirm with the gateway.
    expect(allText).toMatch(/confirmation|proxy/i);
  });
});
