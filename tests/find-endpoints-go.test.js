import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { scanGoCodebase } from '../lib/find-endpoints-go.js';

function tmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'find-go-')));
}
function write(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}
const sigs = (r) => r.endpoints.map((e) => `${e.method} ${e.path}`).sort();

describe('scanGoCodebase', () => {
  let dir;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  describe('stdlib ServeMux', () => {
    it('reads the Go 1.22+ method-in-pattern form without leaking the verb', () => {
      // Regression: joining a route prefix before splitting `"GET /pets"`
      // produced the path `/GET /pets`.
      write(dir, 'go.mod', 'module x\n\ngo 1.23\n');
      write(dir, 'main.go', [
        'func main() {',
        '\tmux := http.NewServeMux()',
        '\tmux.HandleFunc("GET /pets", listPets)',
        '\tmux.HandleFunc("POST /pets", createPet)',
        '\tmux.HandleFunc("GET /pets/{id}", getPet)',
        '\thttp.ListenAndServe(":8080", mux)',
        '}',
      ].join('\n'));
      expect(sigs(scanGoCodebase(dir))).toEqual(['GET /pets', 'GET /pets/{id}', 'POST /pets']);
    });

    it('reads the older method-less form, defaulting to GET', () => {
      write(dir, 'go.mod', 'module x\n');
      write(dir, 'main.go', 'mux.HandleFunc("/health", health)\n');
      expect(sigs(scanGoCodebase(dir))).toEqual(['GET /health']);
    });

    it('collapses a stdlib trailing wildcard', () => {
      write(dir, 'go.mod', 'module x\n');
      write(dir, 'main.go', 'mux.HandleFunc("GET /files/{path...}", serve)\n');
      expect(sigs(scanGoCodebase(dir))).toEqual(['GET /files/{path}']);
    });
  });

  describe('chi', () => {
    it('carries Route nesting and releases it afterwards', () => {
      write(dir, 'go.mod', 'module x\n\nrequire github.com/go-chi/chi/v5 v5.0.11\n');
      write(dir, 'main.go', [
        'r := chi.NewRouter()',
        'r.Get("/health", health)',
        'r.Route("/api/v1", func(r chi.Router) {',
        '\tr.Get("/pets", listPets)',
        '\tr.Delete("/pets/{id}", deletePet)',
        '})',
        'r.Get("/after", afterGroup)',
      ].join('\n'));
      const s = sigs(scanGoCodebase(dir));
      expect(s).toContain('GET /api/v1/pets');
      expect(s).toContain('DELETE /api/v1/pets/{id}');
      expect(s).toContain('GET /health');
      // A route after the group closed must not inherit its prefix.
      expect(s).toContain('GET /after');
    });

    it('reports chi as the framework', () => {
      write(dir, 'go.mod', 'module x\n\nrequire github.com/go-chi/chi/v5 v5.0.11\n');
      write(dir, 'main.go', 'r := chi.NewRouter()\nr.Get("/x", h)\n');
      const s = scanGoCodebase(dir).frameworkSignals[0];
      expect(s.frameworkDeps).toContain('github.com/go-chi/chi/v5');
      expect(s.sourceMarkers).toContain('chi.NewRouter()');
    });
  });

  describe('gorilla/mux', () => {
    it('reads methods from the CHAINED .Methods call', () => {
      // Regression: a tail capture that stopped at the HandleFunc's closing
      // paren never saw `.Methods(...)`, so POST was silently dropped.
      write(dir, 'go.mod', 'module x\n\nrequire github.com/gorilla/mux v1.8.1\n');
      write(dir, 'routes.go', [
        'r.HandleFunc("/orders", listOrders).Methods("GET", "POST")',
        'r.HandleFunc("/orders/{id}", getOrder).Methods("GET")',
      ].join('\n'));
      expect(sigs(scanGoCodebase(dir))).toEqual([
        'GET /orders', 'GET /orders/{id}', 'POST /orders',
      ]);
    });
  });

  describe('gin and echo', () => {
    it('reads uppercase verb calls and normalizes :id', () => {
      // gin and echo are the only Go routers using the `:id` form; stdlib and
      // chi already write `{id}`.
      write(dir, 'go.mod', 'module x\n\nrequire github.com/gin-gonic/gin v1.9.1\n');
      write(dir, 'main.go', [
        'r := gin.Default()',
        'r.GET("/pets/:id", getPet)',
        'r.PATCH("/pets/:id", updatePet)',
      ].join('\n'));
      expect(sigs(scanGoCodebase(dir))).toEqual(['GET /pets/{id}', 'PATCH /pets/{id}']);
    });
  });

  describe('noise control', () => {
    it('skips vendored code and test files', () => {
      write(dir, 'go.mod', 'module x\n');
      write(dir, 'main.go', 'mux.HandleFunc("GET /real", h)\n');
      write(dir, 'vendor/github.com/x/y/router.go', 'mux.HandleFunc("GET /vendored", h)\n');
      write(dir, 'main_test.go', 'mux.HandleFunc("GET /fixture", h)\n');
      expect(sigs(scanGoCodebase(dir))).toEqual(['GET /real']);
    });

    it('ignores commented-out routes', () => {
      write(dir, 'go.mod', 'module x\n');
      write(dir, 'main.go', '// mux.HandleFunc("GET /disabled", h)\nmux.HandleFunc("GET /live", h)\n');
      expect(sigs(scanGoCodebase(dir))).toEqual(['GET /live']);
    });

    it('does not treat a Group assigned to a variable as nesting', () => {
      // `api := r.Group("/api")` does not open a block; treating it as
      // nesting would prefix every later route in the file.
      write(dir, 'go.mod', 'module x\n');
      write(dir, 'main.go', 'api := r.Group("/api")\nr.GET("/health", h)\n');
      expect(sigs(scanGoCodebase(dir))).toContain('GET /health');
    });
  });

  describe('framework signals', () => {
    it('surfaces a Go server with no regex-visible routes', () => {
      write(dir, 'go.mod', 'module x\n');
      write(dir, 'main.go', 'srv := &http.Server{Addr: ":8080"}\nsrv.ListenAndServe()\n');
      const r = scanGoCodebase(dir);
      expect(r.endpoints).toEqual([]);
      expect(r.frameworkSignals[0].sourceMarkers).toContain('http.Server{}');
    });

    it('reads the module name and OAS-capable deps from go.mod', () => {
      write(dir, 'go.mod', 'module example.com/api\n\nrequire github.com/swaggo/swag v1.16.2\n');
      write(dir, 'main.go', 'mux := http.NewServeMux()\nmux.HandleFunc("GET /x", h)\n');
      const s = scanGoCodebase(dir).frameworkSignals[0];
      expect(s.name).toBe('example.com/api');
      expect(s.oasGenDeps).toContain('github.com/swaggo/swag');
    });
  });

  describe('shape parity with the other scanners', () => {
    it('returns the same keys generate-oas renders', () => {
      write(dir, 'go.mod', 'module x\n');
      write(dir, 'main.go', 'mux := http.NewServeMux()\nmux.HandleFunc("GET /x", h)\n');
      const r = scanGoCodebase(dir);
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
  const fixtures = '/Users/marc/Developer/restless/test-apis/go';
  const available = fs.existsSync(fixtures);

  it.skipIf(!available)('finds every stdlib route with its real method', () => {
    const s = sigs(scanGoCodebase(fixtures));
    expect(s).toContain('GET /pets');
    expect(s).toContain('POST /pets');
    expect(s).toContain('GET /pets/{id}');
    // No path may keep the verb it was declared with.
    expect(s.every((x) => !/\/(GET|POST|PUT|DELETE) /.test(x))).toBe(true);
  });
});
