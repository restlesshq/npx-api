import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildEndpointChecklist } from '../steps/generate-oas.js';

let dir;

function write(rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restless-checklist-'));
  write('package.json', JSON.stringify({ dependencies: { express: '^4' } }));
});
afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe('buildEndpointChecklist', () => {
  it('lists call-expression routes, which used to produce nothing at all', () => {
    // The bug this fixes: the checklist only kept `style: 'file'` routes, so
    // an Express app - i.e. most customers - handed the generator an empty
    // string and the "do not drop any of these paths" rule had no list.
    write('src/routes/user.js', [
      "router.get('/', list);",
      "router.post('/', create);",
      "router.get('/:id', show);",
    ].join('\n'));

    const out = buildEndpointChecklist(dir);
    expect(out).toContain('Route inventory');
    expect(out).toContain('src/routes/user.js');
    expect(out).toContain('GET, POST /');
    expect(out).toContain('GET /:id');
  });

  it('states the operation count as a floor, never a target', () => {
    // A regex undercounts, so a spec with MORE operations is correct. The
    // wording must not invite the model to delete real endpoints to match.
    write('src/routes/user.js', "router.get('/', list);\nrouter.post('/', create);");
    const out = buildEndpointChecklist(dir);
    expect(out).toContain('2 route definitions');
    expect(out).toMatch(/FLOOR, not a target/);
    expect(out).toMatch(/Never delete an operation/);
  });

  it('warns that call-expression paths are mount-relative', () => {
    // `app.use(config.apiPrefix, routes())` is not resolvable, so the model
    // has to be told plainly not to copy `/:id` straight into `paths`.
    write('src/routes/user.js', "router.get('/:id', show);");
    const out = buildEndpointChecklist(dir);
    expect(out).toContain('RELATIVE to wherever that router gets mounted');
    expect(out).toContain('Do not copy these strings into `paths` as-is');
  });

  it('groups routes under the file that declares them', () => {
    write('src/routes/user.js', "router.get('/', listUsers);");
    write('src/routes/task.js', "router.get('/', listTasks);");
    const out = buildEndpointChecklist(dir);
    expect(out).toContain('### src/routes/task.js');
    expect(out).toContain('### src/routes/user.js');
    expect(out).toContain('across 2 files');
  });

  it('keeps file-based routes in their own authoritative section', () => {
    // Next.js file routes ARE the full URL, so those stay a hard MUST list -
    // that behaviour is unchanged.
    write('app/api/things/route.ts', 'export async function GET() {}');
    const out = buildEndpointChecklist(dir);
    expect(out).toContain('Endpoint checklist');
    expect(out).toContain('MUST all appear');
    expect(out).toContain('/api/things');
  });

  it('emits both sections when a repo has both shapes', () => {
    write('app/api/things/route.ts', 'export async function GET() {}');
    write('src/routes/user.js', "router.get('/:id', show);");
    const out = buildEndpointChecklist(dir);
    expect(out).toContain('Endpoint checklist');
    expect(out).toContain('Route inventory');
    expect(out.indexOf('Endpoint checklist')).toBeLessThan(out.indexOf('Route inventory'));
  });

  it('returns an empty string when the scan finds no routes', () => {
    write('src/util.js', 'export const x = 1;');
    expect(buildEndpointChecklist(dir)).toBe('');
  });

  it('does not throw on an unreadable directory', () => {
    expect(() => buildEndpointChecklist(path.join(dir, 'nope'))).not.toThrow();
  });
});
