import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { scanRubyCodebase } from '../lib/find-endpoints-ruby.js';

function tmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'find-rb-')));
}
function write(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}
const sigs = (r) => r.endpoints.map((e) => `${e.method} ${e.path}`).sort();

describe('scanRubyCodebase', () => {
  let dir;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  describe('Rails URL DSL', () => {
    it('expands `resources` into the five API endpoints it stands for', () => {
      // Most Rails routes are never written out. Reading routes.rb literally
      // would find one line and report one endpoint.
      write(dir, 'Gemfile', 'gem "rails"\n');
      write(dir, 'config/routes.rb', 'Rails.application.routes.draw do\n  resources :pets\nend\n');
      expect(sigs(scanRubyCodebase(dir))).toEqual([
        'DELETE /pets/{id}', 'GET /pets', 'GET /pets/{id}', 'PATCH /pets/{id}', 'POST /pets',
      ]);
    });

    it('omits new and edit, which are HTML forms and absent in api_only apps', () => {
      write(dir, 'Gemfile', 'gem "rails"\n');
      write(dir, 'config/routes.rb', 'Rails.application.routes.draw do\n  resources :pets\nend\n');
      const paths = scanRubyCodebase(dir).endpoints.map((e) => e.path);
      expect(paths).not.toContain('/pets/new');
      expect(paths).not.toContain('/pets/{id}/edit');
    });

    it('honours only: and except:', () => {
      write(dir, 'Gemfile', 'gem "rails"\n');
      write(dir, 'config/routes.rb', [
        'Rails.application.routes.draw do',
        '  resources :orders, only: [:index, :show]',
        '  resources :carts, except: [:destroy]',
        'end',
      ].join('\n'));
      const s = sigs(scanRubyCodebase(dir));
      expect(s).toContain('GET /orders');
      expect(s).toContain('GET /orders/{id}');
      expect(s).not.toContain('POST /orders');
      expect(s).not.toContain('DELETE /carts/{id}');
      expect(s).toContain('POST /carts');
    });

    it('gives a singular `resource` no index and no id', () => {
      write(dir, 'Gemfile', 'gem "rails"\n');
      write(dir, 'config/routes.rb', 'Rails.application.routes.draw do\n  resource :session, only: [:create, :destroy]\nend\n');
      expect(sigs(scanRubyCodebase(dir))).toEqual(['DELETE /session', 'POST /session']);
    });

    it('carries nested namespace and scope prefixes without repeating them', () => {
      // Regression: each stack frame holds the cumulative prefix, so joining
      // every frame produced /api/api/v1.
      write(dir, 'Gemfile', 'gem "rails"\n');
      write(dir, 'config/routes.rb', [
        'Rails.application.routes.draw do',
        '  namespace :api do',
        '    scope "/v1" do',
        '      resources :orders, only: [:index]',
        '      get "health", to: "health#show"',
        '    end',
        '  end',
        '  get "/legacy/:slug", to: "legacy#show"',
        'end',
      ].join('\n'));
      const s = sigs(scanRubyCodebase(dir));
      expect(s).toContain('GET /api/v1/orders');
      expect(s).toContain('GET /api/v1/health');
      // A route after the blocks closed must not inherit the prefix.
      expect(s).toContain('GET /legacy/{slug}');
    });

    it('normalizes params the way the SDK does at runtime', () => {
      // The SDK strips the verb, drops (.:format) and rewrites :id. If the
      // scanner disagreed, the spec and the logs would group differently.
      write(dir, 'Gemfile', 'gem "rails"\n');
      write(dir, 'config/routes.rb', [
        'Rails.application.routes.draw do',
        '  get "/pets/:pet_id/toys/:id(.:format)", to: "toys#show"',
        'end',
      ].join('\n'));
      expect(sigs(scanRubyCodebase(dir))).toEqual(['GET /pets/{pet_id}/toys/{id}']);
    });

    it('reads root as GET /', () => {
      write(dir, 'Gemfile', 'gem "rails"\n');
      write(dir, 'config/routes.rb', 'Rails.application.routes.draw do\n  root "home#index"\nend\n');
      expect(sigs(scanRubyCodebase(dir))).toEqual(['GET /']);
    });
  });

  describe('Sinatra, Roda and Grape blocks', () => {
    it('reads verb blocks with inline paths', () => {
      write(dir, 'Gemfile', 'gem "sinatra"\n');
      write(dir, 'app.rb', [
        'class App < Sinatra::Base',
        '  get "/pets" do',
        '    json Pet.all',
        '  end',
        '  post "/pets" do',
        '    201',
        '  end',
        '  get "/pets/:id" do',
        '    json Pet.find(params[:id])',
        '  end',
        'end',
      ].join('\n'));
      const r = scanRubyCodebase(dir);
      expect(sigs(r)).toEqual(['GET /pets', 'GET /pets/{id}', 'POST /pets']);
      expect(r.frameworkSignals[0].sourceMarkers).toContain('Sinatra::Base');
    });

    it('does not apply the Rails DSL outside a routes file', () => {
      // `resources :pets` means nothing in a Sinatra app, and expanding it
      // there would invent five endpoints.
      write(dir, 'Gemfile', 'gem "sinatra"\n');
      write(dir, 'app.rb', 'class App < Sinatra::Base\n  resources :pets\nend\n');
      expect(scanRubyCodebase(dir).endpoints).toEqual([]);
    });
  });

  describe('framework signals', () => {
    it('reads gems from a Gemfile and a gemspec', () => {
      write(dir, 'Gemfile', 'source "https://rubygems.org"\ngem "grape"\ngem "rswag-api"\n');
      write(dir, 'api.rb', 'class API < Grape::API\n  get "/pets" do\n  end\nend\n');
      const s = scanRubyCodebase(dir).frameworkSignals[0];
      expect(s.frameworkDeps).toContain('grape');
      expect(s.oasGenDeps).toContain('rswag-api');
      expect(s.sourceMarkers).toContain('Grape::API');
    });

    it('surfaces a Rails app whose routes file only mounts engines', () => {
      // The reason signals exist: a real API with no regex-visible routes.
      write(dir, 'Gemfile', 'gem "rails"\n');
      write(dir, 'config/routes.rb', 'Rails.application.routes.draw do\n  mount Other::Engine => "/other"\nend\n');
      const r = scanRubyCodebase(dir);
      expect(r.endpoints).toEqual([]);
      expect(r.frameworkSignals[0].frameworkDeps).toEqual(['rails']);
      expect(r.frameworkSignals[0].sourceMarkers).toContain('routes.draw');
    });

    it('reports signals with no Gemfile at all', () => {
      write(dir, 'config.ru', 'require "sinatra/base"\nrun App\n');
      write(dir, 'app.rb', 'class App < Sinatra::Base\n  get "/x" do\n  end\nend\n');
      const r = scanRubyCodebase(dir);
      expect(sigs(r)).toEqual(['GET /x']);
      expect(r.frameworkSignals[0].package).toBe('.');
    });
  });

  describe('noise control', () => {
    it('skips vendored gems and build dirs', () => {
      write(dir, 'Gemfile', 'gem "sinatra"\n');
      write(dir, 'app.rb', 'class App < Sinatra::Base\n  get "/real" do\n  end\nend\n');
      write(dir, 'vendor/bundle/ruby/3.3/gems/sinatra/lib/x.rb', 'get "/vendored" do\nend\n');
      write(dir, 'tmp/cache/y.rb', 'get "/cached" do\nend\n');
      expect(sigs(scanRubyCodebase(dir))).toEqual(['GET /real']);
    });

    it('ignores commented-out routes', () => {
      write(dir, 'Gemfile', 'gem "rails"\n');
      write(dir, 'config/routes.rb', [
        'Rails.application.routes.draw do',
        '  # resources :disabled',
        '  resources :pets, only: [:index]',
        'end',
      ].join('\n'));
      expect(sigs(scanRubyCodebase(dir))).toEqual(['GET /pets']);
    });
  });

  describe('shape parity with the other scanners', () => {
    it('returns the same keys generate-oas renders', () => {
      write(dir, 'Gemfile', 'gem "sinatra"\n');
      write(dir, 'app.rb', 'class App < Sinatra::Base\n  get "/x" do\n  end\nend\n');
      const r = scanRubyCodebase(dir);
      expect(Object.keys(r).sort()).toEqual(
        ['endpoints', 'filesWithEndpoints', 'frameworkSignals', 'scannedFileCount'].sort(),
      );
      expect(Object.keys(r.frameworkSignals[0]).sort()).toEqual(
        ['endpointCount', 'frameworkDeps', 'name', 'oasGenDeps', 'package', 'sourceMarkers'].sort(),
      );
    });
  });
});

describe('against the real pet-store fixture', () => {
  const fixtures = '/Users/marc/Developer/restless/test-apis/ruby';
  const available = fs.existsSync(fixtures);

  it.skipIf(!available)('finds no declarative routes, because it dispatches by hand', () => {
    // The bare-Rack fixture matches on PATH_INFO itself, exactly like the
    // Python bare-WSGI one. Contributing none is correct; inventing them from
    // the string literals it compares against would not be.
    expect(scanRubyCodebase(fixtures).endpoints).toEqual([]);
  });
});
