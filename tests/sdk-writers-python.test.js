import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import * as py from '../lib/sdk-writers/python.js';
import { assertWriterShape } from '../lib/sdk-writers/index.js';

/** The shape the guide tells an installer to write. */
function wired({ arg = 'os.environ["RESTLESS_KEY"]', ownerId = 'workspace_id_for(request)', confirm = null } = {}) {
  return [
    'import os',
    'import restless',
    '',
    `client = restless.Restless(${arg})`,
    '',
    '@client.setup',
    'def _(request):',
    '    return {',
    '        "api_key": client.mask(request.headers.get("authorization")),',
    ...(confirm ? [`        # RESTLESS_OWNER_ID_CONFIRM: ${confirm}`] : []),
    '        "owner": {',
    `            "id": ${ownerId},`,
    '            "enrich": lambda owner_id: {"label": lookup(owner_id)},',
    '        },',
    '    }',
    '',
    'app.wsgi_app = client.wsgi(app.wsgi_app)',
  ].join('\n');
}

describe('conformance to the shared writer interface', () => {
  it('satisfies the shared writer contract', () => {
    // The registry asserts this at import for every registered writer; the
    // explicit call keeps the failure readable when it is this one.
    expect(() => assertWriterShape('python', py)).not.toThrow();
  });

  it('spells the CONTRACT §15 concepts in snake_case', () => {
    expect(py.descriptor.fields).toEqual({
      apiKey: 'api_key',
      owner: 'owner',
      ownerId: 'id',
      enrich: 'enrich',
    });
  });

  it('separates the install name from the import name', () => {
    // pip installs `restless-sdk`; source says `import restless`. Conflating
    // them is how you end up grepping for a package name that never appears.
    expect(py.descriptor.packageSpecifier).toBe('restless-sdk');
    expect(py.descriptor.importName).toBe('restless');
  });
});

describe('hasSdkReference / hasInit', () => {
  it('recognizes every import form the SDK supports', () => {
    for (const imp of [
      'import restless',
      'import restless as rl',
      'from restless import Restless',
      'from restless import restless',
      'from restless import Restless, mask',
    ]) {
      expect(py.hasSdkReference(`${imp}\n`), imp).toBe(true);
    }
  });

  it('tolerates a trailing comment on the import line', () => {
    // Regression: all three real pet-store fixtures write
    // `import restless  # noqa: E402`, and an end-of-line anchor that did not
    // allow for it matched NONE of them. `# type: ignore` and
    // `# pylint: disable` are just as common.
    expect(py.hasSdkReference('import restless  # noqa: E402\n')).toBe(true);
    expect(py.hasSdkReference('from restless import Restless  # type: ignore\n')).toBe(true);
    expect(py.hasInit('import restless  # noqa\nc = restless.Restless("k")\n')).toBe(true);
  });

  it('handles a parenthesized multi-line import', () => {
    const src = 'from restless import (\n    Restless,\n    mask,\n)\n\nc = Restless("k")\n';
    expect(py.hasSdkReference(src)).toBe(true);
    expect(py.hasInit(src)).toBe(true);
  });

  it('handles a multi-line constructor call', () => {
    const src = 'import restless\nclient = restless.Restless(\n    os.environ["RESTLESS_KEY"],\n)\n';
    expect(py.hasInit(src)).toBe(true);
    expect(py.readBlockFields(src).initArgForm).toBe('env-ref');
  });

  it('is not fooled by lookalike identifiers or prose', () => {
    expect(py.hasSdkReference('restless_var = 1\n')).toBe(false);
    expect(py.hasSdkReference('# restlessness is a virtue\n')).toBe(false);
    expect(py.hasSdkReference('import restlessness\n')).toBe(false);
    expect(py.hasSdkReference('')).toBe(false);
  });

  it('treats a construction through any import form as wired', () => {
    const cases = [
      ['import restless', 'client = restless.Restless("k")'],
      ['import restless', 'client = restless.restless("k")'],
      ['import restless as rl', 'client = rl.Restless("k")'],
      ['from restless import Restless', 'client = Restless("k")'],
      ['from restless import restless', 'client = restless("k")'],
      ['from restless import Restless as Client', 'client = Client("k")'],
    ];
    for (const [imp, call] of cases) {
      expect(py.hasInit(`${imp}\n${call}\n`), `${imp} / ${call}`).toBe(true);
    }
  });

  it('does not treat an import without construction as wired', () => {
    // Importing `mask` for a unit test must not read as a wired server.
    expect(py.hasInit('from restless import mask\nassert mask("x")\n')).toBe(false);
    expect(py.hasInit('import restless\n')).toBe(false);
  });
});

describe('readBlockFields', () => {
  it('reads the init arg, credential and owner id from a wired file', () => {
    const f = py.readBlockFields(wired());
    expect(f.initArgForm).toBe('env-ref');
    expect(f.initArgValue).toBe('RESTLESS_KEY');
    expect(f.credentialExpr).toBe('request.headers.get("authorization")');
    expect(f.ownerIdExpr).toBe('workspace_id_for(request)');
    expect(f.ownerIdConfirmReason).toBeNull();
  });

  it('handles every environment-lookup idiom', () => {
    for (const [arg, expected] of [
      ['os.environ["RESTLESS_KEY"]', 'RESTLESS_KEY'],
      ["os.environ.get('RESTLESS_KEY')", 'RESTLESS_KEY'],
      ['os.getenv("RESTLESS_KEY")', 'RESTLESS_KEY'],
    ]) {
      const f = py.readBlockFields(wired({ arg }));
      expect(f.initArgForm, arg).toBe('env-ref');
      expect(f.initArgValue, arg).toBe(expected);
    }
  });

  it('reads a literal key and a no-arg constructor', () => {
    expect(py.readBlockFields(wired({ arg: '"rstlss_abc123"' })).initArgForm).toBe('literal');
    expect(py.readBlockFields(wired({ arg: '"rstlss_abc123"' })).initArgValue).toBe('rstlss_abc123');
    expect(py.readBlockFields(wired({ arg: '' })).initArgForm).toBe('no-arg');
  });

  it('balances parens so a nested credential call is not truncated', () => {
    // `[^)]*` would stop at the inner `)` and lose the rest.
    const src = wired().replace(
      'client.mask(request.headers.get("authorization"))',
      'client.mask(request.headers.get("authorization", "")[7:])',
    );
    expect(py.readBlockFields(src).credentialExpr).toBe(
      'request.headers.get("authorization", "")[7:]',
    );
  });

  it('reads mask called as a module export or bare import', () => {
    const viaModule = wired().replace('client.mask(', 'restless.mask(');
    expect(py.readBlockFields(viaModule).credentialExpr).toBe(
      'request.headers.get("authorization")',
    );
    const bare = wired().replace('client.mask(', 'mask(');
    expect(py.readBlockFields(bare).credentialExpr).toBe(
      'request.headers.get("authorization")',
    );
  });

  it('accepts single-quoted dict keys', () => {
    const single = wired().replace(/"api_key"/, "'api_key'").replace(/"owner"/, "'owner'").replace(/"id"/, "'id'");
    const f = py.readBlockFields(single);
    expect(f.credentialExpr).toBe('request.headers.get("authorization")');
    expect(f.ownerIdExpr).toBe('workspace_id_for(request)');
  });

  it('surfaces the confirm marker reason', () => {
    const f = py.readBlockFields(wired({ confirm: 'guessed from request.user' }));
    expect(f.ownerIdConfirmReason).toBe('guessed from request.user');
  });

  it('returns empty fields for unrelated content', () => {
    const f = py.readBlockFields('def handler(request):\n    return {}\n');
    expect(f.ownerIdExpr).toBeNull();
    expect(f.credentialExpr).toBeNull();
  });
});

describe('setOwnerId', () => {
  it('swaps an existing owner id in place', () => {
    const out = py.setOwnerId(wired(), 'request.state.workspace_uuid');
    expect(out).toContain('"id": request.state.workspace_uuid,');
    expect(out).not.toContain('workspace_id_for(request)');
    expect(py.readBlockFields(out).ownerIdExpr).toBe('request.state.workspace_uuid');
  });

  it('inserts an owner entry when none exists, matching the api_key indent', () => {
    const noOwner = [
      'import restless',
      'client = restless.Restless()',
      '@client.setup',
      'def _(request):',
      '    return {',
      '        "api_key": client.mask(request.headers.get("authorization")),',
      '    }',
    ].join('\n');
    const out = py.setOwnerId(noOwner, 'tenant_id(request)');
    expect(out).toContain('        "owner": {"id": tenant_id(request)},');
    expect(py.readBlockFields(out).ownerIdExpr).toBe('tenant_id(request)');
  });

  it('refuses to touch an owner written as something other than a dict literal', () => {
    // A conditional the user wrote on purpose. Inserting a second `owner`
    // key would silently shadow theirs, so we bail and let the repair flow
    // surface it.
    const conditional = wired().replace(
      /"owner": \{[\s\S]*?\n        \},/,
      '"owner": owner_for(request) if request.user else None,',
    );
    expect(py.setOwnerId(conditional, 'x.id')).toBe(conditional);
  });

  it('is a no-op without an SDK import, or with an empty expression', () => {
    expect(py.setOwnerId('x = 1\n', 'a.b')).toBe('x = 1\n');
    expect(py.setOwnerId(wired(), '')).toBe(wired());
  });
});

describe('stripOwnerIdConfirm', () => {
  it('removes the marker line and leaves the owner entry intact', () => {
    const src = wired({ confirm: 'guessed from request.user' });
    const out = py.stripOwnerIdConfirm(src);
    expect(out).not.toContain('RESTLESS_OWNER_ID_CONFIRM');
    expect(out).toContain('"owner": {');
    expect(py.readBlockFields(out).ownerIdExpr).toBe('workspace_id_for(request)');
  });

  it('is idempotent when no marker is present', () => {
    const src = wired();
    expect(py.stripOwnerIdConfirm(src)).toBe(src);
  });
});

describe('canonicalizeInitArg', () => {
  const ctx = (over) => ({ keyDelivery: 'manual', envLoader: { mode: 'dotenv' }, ...over });

  it('rewrites an env-ref to a form that cannot raise at import', () => {
    // `os.environ["X"]` raises KeyError when the loader has not run yet, and
    // a client constructed at module import would take the app down at
    // startup over an observability variable. `.get()` returns None and the
    // SDK falls back to its own lookup.
    const out = py.canonicalizeInitArg(wired({ arg: '' }), ctx());
    expect(out).toContain('restless.Restless(os.environ.get("RESTLESS_KEY"))');
    expect(out).not.toContain('os.environ["RESTLESS_KEY"])');
  });

  it('writes a literal key and adds the inline TODO with a # comment', () => {
    const out = py.canonicalizeInitArg(
      wired({ arg: '' }),
      ctx({ keyDelivery: 'inline', apiKey: 'rstlss_live_123' }),
    );
    expect(out).toContain('restless.Restless("rstlss_live_123")');
    expect(out).toContain('# TODO: move this out of the codebase before committing');
    expect(out).not.toContain('// TODO');
  });

  it('drops the TODO again when leaving inline mode', () => {
    const inline = py.canonicalizeInitArg(
      wired({ arg: '' }),
      ctx({ keyDelivery: 'inline', apiKey: 'rstlss_live_123' }),
    );
    const back = py.canonicalizeInitArg(inline, ctx());
    expect(back).not.toContain('TODO: move this out');
  });

  it('is idempotent', () => {
    const once = py.canonicalizeInitArg(wired({ arg: '' }), ctx());
    expect(py.canonicalizeInitArg(once, ctx())).toBe(once);
  });

  it('leaves the setup callback the AI wrote completely alone', () => {
    const out = py.canonicalizeInitArg(wired({ arg: '"rstlss_old"' }), ctx());
    expect(out).toContain('"api_key": client.mask(request.headers.get("authorization")),');
    expect(out).toContain('"enrich": lambda owner_id: {"label": lookup(owner_id)},');
    expect(out).toContain('app.wsgi_app = client.wsgi(app.wsgi_app)');
  });

  it('handles the no-arg form without leaving stray parens', () => {
    const out = py.canonicalizeInitArg(wired({ arg: '"rstlss_old"' }), ctx({ envLoader: { mode: 'none' } }));
    expect(out).toContain('restless.Restless()');
  });
});

describe('the conditional owner form', () => {
  it('reads and patches an owner assigned outside the dict literal', () => {
    // Regression, found end to end rather than by unit test: this is what you
    // write when the owner is optional, because a dict literal cannot omit a
    // key conditionally without contortions. The real pet-store fixtures use
    // it AND the CLI's own setup-sdk-python prompt tells the AI to write it.
    // A writer that only read the inline form reported "no owner.id is set"
    // for a correct wiring and sent the user into the repair flow.
    const src = [
      'import restless  # noqa: E402',
      'client = restless.Restless(os.environ["RESTLESS_KEY"])',
      '@client.setup',
      'def _(environ):',
      '    result = {"api_key": client.mask(environ.get("HTTP_AUTHORIZATION"))}',
      '    if workspace_id:',
      '        result["owner"] = {"id": workspace_id, "enrich": _load_workspace}',
      '    return result',
    ].join('\n');

    expect(py.hasInit(src)).toBe(true);
    expect(py.readBlockFields(src).credentialExpr).toBe('environ.get("HTTP_AUTHORIZATION")');
    expect(py.readBlockFields(src).ownerIdExpr).toBe('workspace_id');

    const patched = py.setOwnerId(src, 'tenant_id(request)');
    expect(patched).toContain('"id": tenant_id(request)');
    expect(py.readBlockFields(patched).ownerIdExpr).toBe('tenant_id(request)');
  });

  it('still refuses an owner that is not a dict literal at all', () => {
    // A ternary or helper call the user wrote on purpose. Inserting a second
    // owner key would shadow theirs, so bail and let the repair flow ask.
    const src = [
      'import restless',
      'client = restless.Restless()',
      '@client.setup',
      'def _(request):',
      '    return {',
      '        "api_key": client.mask(request.header("authorization")),',
      '        "owner": owner_for(request) if request.user else None,',
      '    }',
    ].join('\n');
    expect(py.setOwnerId(src, 'x.id')).toBe(src);
  });
});

describe('candidateWiringFiles', () => {
  it('finds importing files and skips lookalikes', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'py-writer-')));
    try {
      fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'app', 'main.py'), wired());
      fs.writeFileSync(path.join(dir, 'app', 'decoy.py'), 'restless_var = 1\n# restlessness\n');
      fs.writeFileSync(path.join(dir, 'app', 'notes.md'), 'import restless\n');
      const found = py.candidateWiringFiles(dir);
      expect(found).toEqual([path.join('app', 'main.py')]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
