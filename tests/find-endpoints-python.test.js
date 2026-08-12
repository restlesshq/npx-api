import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { scanPythonCodebase } from '../lib/find-endpoints-python.js';

function tmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'find-py-')));
}

function write(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

const sigs = (r) => r.endpoints.map((e) => `${e.method} ${e.path}`).sort();

describe('scanPythonCodebase', () => {
  let dir;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  describe('Flask', () => {
    it('reads method decorators and normalizes converter syntax', () => {
      write(dir, 'requirements.txt', 'flask==3.0.0\n');
      write(dir, 'app.py', [
        'app = Flask(__name__)',
        '@app.get("/pets")',
        'def list_pets(): ...',
        '@app.post("/pets")',
        'def create(): ...',
        '@app.get("/pets/<int:pet_id>")',
        'def one(pet_id): ...',
        '@app.get("/files/<path:name>")',
        'def f(name): ...',
      ].join('\n'));
      // `<int:pet_id>` -> `{pet_id}` matches what the SDK reports at runtime,
      // so the generated spec lines up with the logs the dashboard receives.
      expect(sigs(scanPythonCodebase(dir))).toEqual([
        'GET /files/{name}', 'GET /pets', 'GET /pets/{pet_id}', 'POST /pets',
      ]);
    });

    it('reads methods= off the generic .route() decorator', () => {
      write(dir, 'requirements.txt', 'flask\n');
      write(dir, 'app.py', [
        '@app.route("/pets", methods=["GET", "POST"])',
        'def pets(): ...',
        '@app.route("/health")',
        'def health(): ...',
      ].join('\n'));
      expect(sigs(scanPythonCodebase(dir))).toEqual(['GET /health', 'GET /pets', 'POST /pets']);
    });

    it('reads blueprints under any receiver name', () => {
      write(dir, 'requirements.txt', 'flask\n');
      write(dir, 'api/routes.py', [
        'bp = Blueprint("api", __name__, url_prefix="/api")',
        '@bp.get("/pets")',
        'def pets(): ...',
      ].join('\n'));
      const r = scanPythonCodebase(dir);
      expect(sigs(r)).toEqual(['GET /pets']);
      expect(r.frameworkSignals[0].sourceMarkers).toContain('Blueprint()');
    });

    it('reads the imperative add_url_rule form', () => {
      write(dir, 'requirements.txt', 'flask\n');
      write(dir, 'app.py', 'app.add_url_rule("/legacy", view_func=v, methods=["PUT"])\n');
      expect(sigs(scanPythonCodebase(dir))).toEqual(['PUT /legacy']);
    });
  });

  describe('FastAPI', () => {
    it('reads decorators regardless of what the app variable is called', () => {
      // The real pet-store fixture uses `api = FastAPI()`, not `app`.
      write(dir, 'pyproject.toml', '[project]\nname = "svc"\ndependencies = ["fastapi>=0.110", "uvicorn[standard]"]\n');
      write(dir, 'main.py', [
        'api = FastAPI()',
        '@api.get("/pets")',
        'async def list_pets(): ...',
        '@api.post("/pets", status_code=201)',
        'async def create(): ...',
        '@api.get("/pets/{pet_id}")',
        'async def one(pet_id: int): ...',
      ].join('\n'));
      const r = scanPythonCodebase(dir);
      expect(sigs(r)).toEqual(['GET /pets', 'GET /pets/{pet_id}', 'POST /pets']);
      expect(r.frameworkSignals[0].frameworkDeps).toContain('fastapi');
      // FastAPI serves /openapi.json itself, so generate-oas can offer to
      // take the spec from the framework instead of writing one.
      expect(r.frameworkSignals[0].oasGenDeps).toContain('fastapi');
    });

    it('reads APIRouter routes', () => {
      write(dir, 'requirements.txt', 'fastapi\n');
      write(dir, 'routers/pets.py', [
        'router = APIRouter(prefix="/v1")',
        '@router.delete("/pets/{pet_id}")',
        'async def rm(pet_id): ...',
      ].join('\n'));
      const r = scanPythonCodebase(dir);
      expect(sigs(r)).toEqual(['DELETE /pets/{pet_id}']);
      expect(r.frameworkSignals[0].sourceMarkers).toContain('APIRouter()');
    });
  });

  describe('Django', () => {
    it('reads path() and re_path() from a URLconf', () => {
      write(dir, 'requirements.txt', 'django>=5.0\ndjangorestframework\n');
      write(dir, 'app/urls.py', [
        'from django.urls import path, re_path, include',
        'urlpatterns = [',
        '    path("", views.index),',
        '    path("pets/", views.pets),',
        '    path("pets/<int:pk>/", views.one),',
        '    re_path(r"^legacy/$", views.legacy),',
        '    path("api/", include("other.urls")),',
        ']',
      ].join('\n'));
      const r = scanPythonCodebase(dir);
      expect(sigs(r)).toEqual([
        'GET /', 'GET /api/', 'GET /legacy/', 'GET /pets/', 'GET /pets/{pk}/',
      ]);
      expect(r.frameworkSignals[0].frameworkDeps).toEqual(['django', 'djangorestframework']);
    });

    it('only treats path() as a route inside a URLconf', () => {
      // `path(...)` is also os.path in ordinary modules; matching it there
      // would invent endpoints out of filesystem code.
      write(dir, 'requirements.txt', 'django\n');
      write(dir, 'util.py', 'from os import path\nx = path("/tmp/thing")\n');
      expect(scanPythonCodebase(dir).endpoints).toEqual([]);
    });

    it('recognizes a urlpatterns file not named urls.py', () => {
      write(dir, 'requirements.txt', 'django\n');
      write(dir, 'app/routes.py', 'urlpatterns = [\n    path("pets/", v),\n]\n');
      expect(sigs(scanPythonCodebase(dir))).toEqual(['GET /pets/']);
    });
  });

  describe('Starlette', () => {
    it('reads a route table with explicit methods', () => {
      write(dir, 'requirements.txt', 'starlette\n');
      write(dir, 'main.py', [
        'routes = [',
        '    Route("/pets", list_pets, methods=["GET", "POST"]),',
        '    Route("/pets/{pet_id}", one),',
        ']',
        'app = Starlette(routes=routes)',
      ].join('\n'));
      expect(sigs(scanPythonCodebase(dir))).toEqual([
        'GET /pets', 'GET /pets/{pet_id}', 'POST /pets',
      ]);
    });
  });

  describe('framework signals', () => {
    it('parses every manifest format', () => {
      const cases = [
        ['requirements.txt', 'Flask==3.0.0  # pinned\n-r other.txt\n'],
        ['pyproject.toml', '[project]\ndependencies = ["flask>=3"]\n'],
        ['Pipfile', '[packages]\nflask = "*"\n'],
      ];
      for (const [file, body] of cases) {
        const d = tmp();
        try {
          write(d, file, body);
          write(d, 'app.py', '@app.get("/x")\ndef x(): ...\n');
          expect(scanPythonCodebase(d).frameworkSignals[0].frameworkDeps, file).toContain('flask');
        } finally {
          fs.rmSync(d, { recursive: true, force: true });
        }
      }
    });

    it('merges manifests that share a directory instead of splitting the package', () => {
      write(dir, 'pyproject.toml', '[project]\nname = "svc"\n');
      write(dir, 'requirements.txt', 'fastapi\n');
      write(dir, 'main.py', '@app.get("/x")\ndef x(): ...\n');
      const r = scanPythonCodebase(dir);
      expect(r.frameworkSignals).toHaveLength(1);
      expect(r.frameworkSignals[0].frameworkDeps).toEqual(['fastapi']);
      expect(r.frameworkSignals[0].name).toBe('svc');
    });

    it('surfaces a framework that shows zero regex-visible routes', () => {
      // The reason signals exist: a Django project whose URLconf only
      // include()s submodules, or a hand-rolled dispatcher, is a real API
      // that the route patterns cannot see.
      write(dir, 'requirements.txt', 'django\n');
      write(dir, 'proj/wsgi.py', 'application = get_wsgi_application()\n');
      const r = scanPythonCodebase(dir);
      expect(r.endpoints).toEqual([]);
      expect(r.frameworkSignals[0].frameworkDeps).toEqual(['django']);
      expect(r.frameworkSignals[0].sourceMarkers).toContain('get_wsgi_application()');
    });

    it('reports signals even with no manifest anywhere', () => {
      write(dir, 'server.py', 'app = Flask(__name__)\n@app.get("/x")\ndef x(): ...\n');
      const r = scanPythonCodebase(dir);
      expect(r.frameworkSignals[0].package).toBe('.');
      expect(r.frameworkSignals[0].sourceMarkers).toContain('Flask()');
      expect(r.frameworkSignals[0].endpointCount).toBe(1);
    });
  });

  describe('noise control', () => {
    it('skips virtualenvs, caches and vendored packages', () => {
      write(dir, 'requirements.txt', 'flask\n');
      write(dir, 'app.py', '@app.get("/real")\ndef r(): ...\n');
      write(dir, '.venv/lib/python3.12/site-packages/flask/app.py', '@app.get("/vendored")\ndef v(): ...\n');
      write(dir, '__pycache__/app.py', '@app.get("/cached")\ndef c(): ...\n');
      expect(sigs(scanPythonCodebase(dir))).toEqual(['GET /real']);
    });

    it('does not mistake the SDK\'s own @client.setup for a route', () => {
      write(dir, 'requirements.txt', 'flask\nrestless-sdk\n');
      write(dir, 'app.py', [
        '@client.setup',
        'def _(environ):',
        '    return {"api_key": client.mask(environ.get("HTTP_AUTHORIZATION"))}',
        '@app.get("/pets")',
        'def pets(): ...',
      ].join('\n'));
      expect(sigs(scanPythonCodebase(dir))).toEqual(['GET /pets']);
    });

    it('de-duplicates a route matched by more than one pattern', () => {
      write(dir, 'requirements.txt', 'flask\n');
      write(dir, 'urls.py', 'urlpatterns = [path("pets/", v)]\n@app.route("/pets/")\ndef p(): ...\n');
      const r = scanPythonCodebase(dir);
      expect(r.endpoints.filter((e) => e.path === '/pets/')).toHaveLength(1);
    });
  });

  describe('shape parity with the JavaScript scanner', () => {
    it('returns the same keys generate-oas renders', () => {
      write(dir, 'requirements.txt', 'fastapi\n');
      write(dir, 'main.py', '@app.get("/x")\ndef x(): ...\n');
      const r = scanPythonCodebase(dir);
      expect(Object.keys(r).sort()).toEqual(
        ['endpoints', 'filesWithEndpoints', 'frameworkSignals', 'scannedFileCount'].sort(),
      );
      expect(r.filesWithEndpoints).toEqual(['main.py']);
      expect(r.scannedFileCount).toBe(1);
      expect(Object.keys(r.frameworkSignals[0]).sort()).toEqual(
        ['endpointCount', 'frameworkDeps', 'name', 'oasGenDeps', 'package', 'sourceMarkers'].sort(),
      );
    });
  });
});

describe('against the real pet-store fixtures', () => {
  const fixtures = '/Users/marc/Developer/restless/test-apis/python';
  const available = fs.existsSync(fixtures);

  it.skipIf(!available)('finds the Flask and FastAPI routes', () => {
    const r = scanPythonCodebase(fixtures);
    const byFile = {};
    for (const e of r.endpoints) (byFile[e.file] ||= []).push(`${e.method} ${e.path}`);

    // Flask writes `<int:pet_id>`, FastAPI writes `{pet_id}`; both must land
    // on `{pet_id}` so one endpoint groups the same way in either stack.
    expect(byFile['petstore_flask.py']).toContain('GET /pets/{pet_id}');
    expect(byFile['petstore_fastapi.py']).toContain('GET /pets/{pet_id}');
    expect(byFile['petstore_flask.py']).toContain('POST /pets');

    // The bare-WSGI fixture dispatches by hand on PATH_INFO, so it has no
    // declarative routes to find. Correctly contributes none rather than
    // inventing them from the string literals it compares against.
    expect(byFile['petstore_wsgi.py']).toBeUndefined();
  });
});
