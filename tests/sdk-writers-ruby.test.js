import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import * as rb from '../lib/sdk-writers/ruby.js';
import { assertWriterShape } from '../lib/sdk-writers/index.js';

/** The shape the guide tells an installer to write. */
function wired({ arg = 'ENV["RESTLESS_KEY"]', ownerId = 'workspace_id', confirm = null, hashrocket = false } = {}) {
  const apiKey = hashrocket
    ? ':api_key => CLIENT.mask(request.header("Authorization"))'
    : 'api_key: CLIENT.mask(request.header("Authorization"))';
  const id = hashrocket ? `:id => ${ownerId}` : `id: ${ownerId}`;
  return [
    'require "restless"',
    '',
    `CLIENT = Restless.new(${arg})`,
    '',
    'CLIENT.setup do |request|',
    `  result = { ${apiKey} }`,
    ...(confirm ? [`  # RESTLESS_OWNER_ID_CONFIRM: ${confirm}`] : []),
    `  result[:owner] = { ${id}, enrich: method(:load_workspace) }`,
    '  result',
    'end',
    '',
    'use CLIENT.rack',
  ].join('\n');
}

describe('conformance to the shared writer interface', () => {
  it('satisfies the shared writer contract', () => {
    expect(() => assertWriterShape('ruby', rb)).not.toThrow();
  });

  it('spells the CONTRACT §15 concepts as Ruby symbol keys', () => {
    expect(rb.descriptor.fields).toEqual({
      apiKey: 'api_key', owner: 'owner', ownerId: 'id', enrich: 'enrich',
    });
  });
});

describe('hasSdkReference / hasInit', () => {
  it('accepts a bare constructor with no require, as Rails produces', () => {
    // Bundler auto-requires gems, so a Rails config/application.rb wires the
    // SDK with no require line anywhere in the file. Demanding an import
    // would report every Rails install as unwired.
    const rails = 'module App\n  class Application < Rails::Application\n'
      + '    CLIENT = Restless.new(ENV["RESTLESS_KEY"])\n'
      + '    config.middleware.insert_before 0, CLIENT.rack\n  end\nend\n';
    expect(rails).not.toContain('require');
    expect(rb.hasSdkReference(rails)).toBe(true);
    expect(rb.hasInit(rails)).toBe(true);
  });

  it('accepts both constructor spellings', () => {
    expect(rb.hasInit('CLIENT = Restless.new("k")\n')).toBe(true);
    expect(rb.hasInit('CLIENT = Restless::Client.new("k")\n')).toBe(true);
  });

  it('does not treat a require alone as wired', () => {
    expect(rb.hasSdkReference('require "restless"\n')).toBe(true);
    expect(rb.hasInit('require "restless"\n')).toBe(false);
  });

  it('is not fooled by lookalikes', () => {
    expect(rb.hasSdkReference('# restless nights\nrestless_var = 1\n')).toBe(false);
    expect(rb.hasSdkReference('require "restless_ui"\n')).toBe(false);
  });
});

describe('readBlockFields', () => {
  it('reads a wired file', () => {
    const f = rb.readBlockFields(wired());
    expect(f.initArgForm).toBe('env-ref');
    expect(f.initArgValue).toBe('RESTLESS_KEY');
    expect(f.credentialExpr).toBe('request.header("Authorization")');
    expect(f.ownerIdExpr).toBe('workspace_id');
  });

  it('reads hashrocket keys as well as the modern spelling', () => {
    // `:api_key => x` is still current Ruby and appears in plenty of real
    // codebases. A writer that knew only `api_key:` would miss half of them.
    const f = rb.readBlockFields(wired({ hashrocket: true }));
    expect(f.credentialExpr).toBe('request.header("Authorization")');
    expect(f.ownerIdExpr).toBe('workspace_id');
  });

  it('takes only the FIRST constructor argument as the key', () => {
    // Ruby passes options as trailing keywords. Treating the whole argument
    // list as the key would read `base_url:` as part of it.
    const f = rb.readBlockFields(wired({
      arg: 'ENV["RESTLESS_KEY"], base_url: "http://localhost:8099", redact: { headers: ["x"] }',
    }));
    expect(f.initArgForm).toBe('env-ref');
    expect(f.initArgValue).toBe('RESTLESS_KEY');
  });

  it('reads a literal key and a no-arg constructor', () => {
    expect(rb.readBlockFields(wired({ arg: '"rstlss_abc"' })).initArgForm).toBe('literal');
    expect(rb.readBlockFields(wired({ arg: '' })).initArgForm).toBe('no-arg');
  });

  it('reads mask called on the module rather than the client', () => {
    const viaModule = wired().replace('CLIENT.mask(', 'Restless.mask(');
    expect(rb.readBlockFields(viaModule).credentialExpr).toBe('request.header("Authorization")');
  });

  it('surfaces the confirm marker reason', () => {
    expect(rb.readBlockFields(wired({ confirm: 'guessed from the header' })).ownerIdConfirmReason)
      .toBe('guessed from the header');
  });
});

describe('setOwnerId', () => {
  it('patches the conditional assignment form the real fixture uses', () => {
    const out = rb.setOwnerId(wired(), 'request.header("X-Tenant")');
    expect(out).toContain('id: request.header("X-Tenant")');
    expect(rb.readBlockFields(out).ownerIdExpr).toBe('request.header("X-Tenant")');
  });

  it('patches a hashrocket owner id', () => {
    const out = rb.setOwnerId(wired({ hashrocket: true }), 'tenant.id');
    expect(rb.readBlockFields(out).ownerIdExpr).toBe('tenant.id');
  });

  it('inserts an owner when none exists', () => {
    const src = [
      'require "restless"',
      'CLIENT = Restless.new',
      'CLIENT.setup do |request|',
      '  { api_key: CLIENT.mask(request.header("Authorization")) }',
      'end',
    ].join('\n');
    const out = rb.setOwnerId(src, 'tenant_id(request)');
    expect(out).toContain('owner: { id: tenant_id(request) }');
  });

  it('refuses an owner that is not a hash literal', () => {
    const src = wired().replace(
      'result[:owner] = { id: workspace_id, enrich: method(:load_workspace) }',
      'result[:owner] = owner_for(request)',
    );
    expect(rb.setOwnerId(src, 'x.id')).toBe(src);
  });
});

describe('canonicalizeInitArg', () => {
  const ctx = (over) => ({ keyDelivery: 'manual', envLoader: { mode: 'dotenv' }, ...over });

  it('uses ENV[...] , which unlike Python cannot raise', () => {
    // Ruby's ENV[] returns nil for a missing key rather than raising, so the
    // idiomatic form is also the safe one.
    const out = rb.canonicalizeInitArg(wired({ arg: '' }), ctx());
    expect(out).toContain('Restless.new(ENV["RESTLESS_KEY"])');
  });

  it('preserves keyword options after the key', () => {
    // The real fixture passes base_url and redact. Rewriting the whole
    // argument list would silently delete the user's configuration.
    const out = rb.canonicalizeInitArg(
      wired({ arg: '"rstlss_old", base_url: "http://localhost:8099"' }), ctx(),
    );
    expect(out).toContain('ENV["RESTLESS_KEY"]');
    expect(out).toContain('base_url: "http://localhost:8099"');
  });

  it('adds the inline TODO with a # comment', () => {
    const out = rb.canonicalizeInitArg(wired({ arg: '' }), ctx({ keyDelivery: 'inline', apiKey: 'rstlss_live_1' }));
    expect(out).toContain('# TODO: move this out of the codebase before committing');
    expect(out).toContain('Restless.new("rstlss_live_1")');
  });

  it('is idempotent', () => {
    const once = rb.canonicalizeInitArg(wired({ arg: '' }), ctx());
    expect(rb.canonicalizeInitArg(once, ctx())).toBe(once);
  });
});

describe('candidateWiringFiles', () => {
  it('puts Rack mount points ahead of the grep', () => {
    // The language the wiringTarget seam exists for: Rails mounts middleware
    // in config/application.rb while the routes live in config/routes.rb, and
    // neither necessarily mentions the gem.
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rb-writer-')));
    try {
      fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'config.ru'), 'use CLIENT.rack\nrun App\n');
      fs.writeFileSync(path.join(dir, 'config', 'application.rb'), 'CLIENT = Restless.new(ENV["RESTLESS_KEY"])\n');
      fs.writeFileSync(path.join(dir, 'app.rb'), 'require "restless"\n');
      const found = rb.candidateWiringFiles(dir);
      expect(found[0]).toBe('config.ru');
      expect(found).toContain(path.join('config', 'application.rb'));
      expect(found).toContain('app.rb');
      expect(new Set(found).size).toBe(found.length);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('against the real pet-store fixture', () => {
  const fixture = '/Users/marc/Developer/restless/test-apis/ruby/petstore.rb';
  const available = fs.existsSync(fixture);

  it.skipIf(!available)('reads every field from it', () => {
    const src = fs.readFileSync(fixture, 'utf8');
    expect(rb.hasInit(src)).toBe(true);
    const f = rb.readBlockFields(src);
    expect(f.initArgForm).toBe('env-ref');
    expect(f.credentialExpr).toBe('request.header("Authorization")');
    expect(f.ownerIdExpr).toBe('workspace_id');
  });
});

describe('the shapes real Ruby apps actually use', () => {
  it('reads a Rails wiring that has no require line', () => {
    // Found end to end: Bundler auto-requires gems, so config/application.rb
    // wires the SDK with no `require "restless"` anywhere in the file.
    // Demanding an import would report every Rails install as unwired.
    const src = [
      'require_relative "boot"',
      'require "rails/all"',
      '',
      'CLIENT = Restless.new(ENV["RESTLESS_KEY"])',
      '',
      'CLIENT.setup do |request|',
      '  result = { api_key: CLIENT.mask(request.header("Authorization")) }',
      '  workspace_id = resolve_workspace(request.header("Authorization"))',
      '  if workspace_id',
      '    result[:owner] = { id: workspace_id, enrich: method(:load_workspace) }',
      '  end',
      '  result',
      'end',
      '',
      'module Railsy',
      '  class Application < Rails::Application',
      '    config.middleware.insert_before 0, CLIENT.rack',
      '  end',
      'end',
    ].join('\n');

    expect(src).not.toContain('require "restless"');
    expect(rb.hasInit(src)).toBe(true);
    const f = rb.readBlockFields(src);
    expect(f.initArgForm).toBe('env-ref');
    expect(f.credentialExpr).toBe('request.header("Authorization")');
    expect(f.ownerIdExpr).toBe('workspace_id');
  });

  it('reads an inline owner hash in a config.ru', () => {
    const src = [
      'require "restless"',
      'CLIENT = Restless.new(ENV["RESTLESS_KEY"])',
      'CLIENT.setup do |request|',
      '  { api_key: CLIENT.mask(request.header("Authorization")),',
      '    owner: { id: request.header("X-Workspace-Id"), enrich: ->(id) { { label: id } } } }',
      'end',
      'use CLIENT.rack',
      'run App',
    ].join('\n');
    const f = rb.readBlockFields(src);
    expect(f.credentialExpr).toBe('request.header("Authorization")');
    expect(f.ownerIdExpr).toBe('request.header("X-Workspace-Id")');
  });
});
