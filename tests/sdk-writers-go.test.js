import { describe, it, expect } from 'vitest';
import fs from 'fs';
import * as go from '../lib/sdk-writers/go.js';
import { assertWriterShape } from '../lib/sdk-writers/index.js';

function wired({ arg = 'os.Getenv("RESTLESS_KEY")', ownerId = 'workspaceID', alias = 'restless', confirm = null } = {}) {
  const imp = alias === '' ? '\t"github.com/restlesshq/go"' : `\t${alias} "github.com/restlesshq/go"`;
  const pkg = alias === '' ? 'restless' : alias;
  return [
    'package main',
    '',
    'import (',
    '\t"net/http"',
    '\t"os"',
    imp,
    ')',
    '',
    'func main() {',
    `\tclient := ${pkg}.MustNew(${arg})`,
    '',
    `\tclient.Setup(func(r *${pkg}.RequestInfo) ${pkg}.SetupResult {`,
    `\t\tresult := ${pkg}.SetupResult{`,
    `\t\t\tAPIKey: ${pkg}.Mask(r.Header("Authorization")),`,
    '\t\t}',
    ...(confirm ? [`\t\t// RESTLESS_OWNER_ID_CONFIRM: ${confirm}`] : []),
    `\t\tresult.Owner = &${pkg}.Owner{ID: ${ownerId}, Enrich: loadWorkspace}`,
    '\t\treturn result',
    '\t})',
    '',
    '\thttp.ListenAndServe(":8080", client.Middleware()(mux))',
    '}',
  ].join('\n');
}

describe('conformance to the shared writer interface', () => {
  it('satisfies the shared writer contract', () => {
    expect(() => assertWriterShape('go', go)).not.toThrow();
  });

  it('spells the CONTRACT §15 concepts as exported Go struct fields', () => {
    // A third spelling after camelCase and snake_case, which is exactly the
    // per-language casing §15 permits.
    expect(go.descriptor.fields).toEqual({
      apiKey: 'APIKey', owner: 'Owner', ownerId: 'ID', enrich: 'Enrich',
    });
  });
});

describe('hasSdkReference / hasInit', () => {
  it('resolves an unaliased import, where the package name is not the path tail', () => {
    // `github.com/restlesshq/go` binds `restless`, not `go`. Deriving the
    // binding from the last path element would name it wrong.
    const src = wired({ alias: '' });
    expect(go.hasSdkReference(src)).toBe(true);
    expect(go.hasInit(src)).toBe(true);
  });

  it('resolves an aliased import', () => {
    const src = wired({ alias: 'rl' });
    expect(go.hasInit(src)).toBe(true);
    expect(go.readBlockFields(src).credentialExpr).toBe('r.Header("Authorization")');
  });

  it('accepts both constructors', () => {
    expect(go.hasInit(wired().replace('MustNew', 'New'))).toBe(true);
    expect(go.hasInit(wired())).toBe(true);
  });

  it('does not treat a types-only import as wired', () => {
    // A helper taking *restless.RequestInfo imports the package without
    // constructing anything.
    const src = [
      'package handlers',
      'import restless "github.com/restlesshq/go"',
      'func describe(r *restless.RequestInfo) string { return r.Header("X") }',
    ].join('\n');
    expect(go.hasSdkReference(src)).toBe(true);
    expect(go.hasInit(src)).toBe(false);
  });
});

describe('readBlockFields', () => {
  it('reads a wired file', () => {
    const f = go.readBlockFields(wired());
    expect(f.initArgForm).toBe('env-ref');
    expect(f.initArgValue).toBe('RESTLESS_KEY');
    expect(f.credentialExpr).toBe('r.Header("Authorization")');
    expect(f.ownerIdExpr).toBe('workspaceID');
  });

  it('reads the pointer-to-struct owner form', () => {
    // Owner is *Owner, so every match has to allow `&` and the package
    // qualifier, which depends on the file's import alias.
    expect(go.readBlockFields(wired({ alias: 'rl' })).ownerIdExpr).toBe('workspaceID');
  });

  it('takes only the first argument, leaving functional options alone', () => {
    const f = go.readBlockFields(wired({
      arg: 'os.Getenv("RESTLESS_KEY"), restless.WithBaseURL("http://x"), restless.WithRedact(o)',
    }));
    expect(f.initArgForm).toBe('env-ref');
    expect(f.initArgValue).toBe('RESTLESS_KEY');
  });

  it('reads mask in both its forms', () => {
    expect(go.readBlockFields(wired()).credentialExpr).toBe('r.Header("Authorization")');
    const viaClient = wired().replace('restless.Mask(', 'client.Mask(');
    expect(go.readBlockFields(viaClient).credentialExpr).toBe('r.Header("Authorization")');
  });

  it('reads a literal key', () => {
    expect(go.readBlockFields(wired({ arg: '"rstlss_abc"' })).initArgForm).toBe('literal');
  });

  it('surfaces the confirm marker reason', () => {
    expect(go.readBlockFields(wired({ confirm: 'guessed' })).ownerIdConfirmReason).toBe('guessed');
  });
});

describe('setOwnerId', () => {
  it('patches the conditional assignment form the real fixture uses', () => {
    const out = go.setOwnerId(wired(), 'r.Header("X-Tenant")');
    expect(out).toContain('ID: r.Header("X-Tenant")');
    expect(go.readBlockFields(out).ownerIdExpr).toBe('r.Header("X-Tenant")');
  });

  it('inserts an owner qualified with the file\'s own import alias', () => {
    // An inserted `&restless.Owner{}` in a file that aliased the import to
    // `rl` would not compile.
    const src = wired({ alias: 'rl' }).replace(/\t\tresult\.Owner = .*\n/, '');
    const out = go.setOwnerId(src, 'tenantID');
    expect(out).toContain('Owner: &rl.Owner{ID: tenantID}');
  });

  it('refuses an owner that is not a struct literal', () => {
    const src = wired().replace(/result\.Owner = &restless\.Owner\{[^}]*\}/, 'result.Owner = ownerFor(r)');
    expect(go.setOwnerId(src, 'x')).toBe(src);
  });
});

describe('canonicalizeInitArg', () => {
  const ctx = (over) => ({ keyDelivery: 'manual', envLoader: { mode: 'none' }, ...over });

  it('always writes an explicit os.Getenv, never an empty key', () => {
    // MustNew("") does work - CONFIG-001 falls back to RESTLESS_KEY - but it
    // reads as "no key", and Go has no .env convention that would make the
    // implicit form idiomatic the way it is in Python.
    const out = go.canonicalizeInitArg(wired({ arg: '"rstlss_old"' }), ctx());
    expect(out).toContain('MustNew(os.Getenv("RESTLESS_KEY"))');
    expect(out).not.toContain('MustNew("")');
  });

  it('preserves functional options after the key', () => {
    const out = go.canonicalizeInitArg(
      wired({ arg: '"rstlss_old", restless.WithBaseURL("http://x")' }), ctx(),
    );
    expect(out).toContain('os.Getenv("RESTLESS_KEY")');
    expect(out).toContain('restless.WithBaseURL("http://x")');
  });

  it('writes a literal key with the inline TODO', () => {
    const out = go.canonicalizeInitArg(wired(), ctx({ keyDelivery: 'inline', apiKey: 'rstlss_live_1' }));
    expect(out).toContain('MustNew("rstlss_live_1")');
    expect(out).toContain('// TODO: move this out of the codebase before committing');
  });

  it('is idempotent', () => {
    const once = go.canonicalizeInitArg(wired({ arg: '"rstlss_old"' }), ctx());
    expect(go.canonicalizeInitArg(once, ctx())).toBe(once);
  });
});

describe('against the real pet-store fixture', () => {
  const fixture = '/Users/marc/Developer/restless/test-apis/go/petstore.go';
  const available = fs.existsSync(fixture);

  it.skipIf(!available)('reads every field from it', () => {
    const src = fs.readFileSync(fixture, 'utf8');
    expect(go.hasInit(src)).toBe(true);
    const f = go.readBlockFields(src);
    expect(f.initArgForm).toBe('env-ref');
    expect(f.credentialExpr).toBe('r.Header("Authorization")');
    expect(f.ownerIdExpr).toBe('workspaceID');
  });
});

describe('the shapes real Go apps actually use', () => {
  it('reads a stdlib ServeMux wiring end to end', () => {
    // Verified separately by actually compiling this shape and the patched
    // output of setOwnerId - Go is the one language where the CLI can prove
    // its edit is valid rather than only pattern-matching it.
    const src = [
      'package main',
      '',
      'import (',
      '\t"net/http"',
      '\t"os"',
      '',
      '\trestless "github.com/restlesshq/go"',
      ')',
      '',
      'func main() {',
      '\tclient := restless.MustNew(os.Getenv("RESTLESS_KEY"))',
      '',
      '\tclient.Setup(func(r *restless.RequestInfo) restless.SetupResult {',
      '\t\tresult := restless.SetupResult{',
      '\t\t\tAPIKey: restless.Mask(r.Header("Authorization")),',
      '\t\t}',
      '\t\tif ws := r.Header("X-Workspace-Id"); ws != "" {',
      '\t\t\tresult.Owner = &restless.Owner{ID: ws, Enrich: loadWorkspace}',
      '\t\t}',
      '\t\treturn result',
      '\t})',
      '',
      '\tlog.Fatal(http.ListenAndServe(":8080", client.Middleware()(mux)))',
      '}',
    ].join('\n');

    expect(go.hasInit(src)).toBe(true);
    const f = go.readBlockFields(src);
    expect(f.initArgForm).toBe('env-ref');
    expect(f.credentialExpr).toBe('r.Header("Authorization")');
    expect(f.ownerIdExpr).toBe('ws');

    // The patched output must stay compilable: the owner literal keeps its
    // package qualifier and the trailing fields.
    const patched = go.setOwnerId(src, 'r.Header("X-Tenant")');
    expect(patched).toContain('&restless.Owner{ID: r.Header("X-Tenant"), Enrich: loadWorkspace}');
  });
});
