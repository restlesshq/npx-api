import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  rankSourceFiles,
  buildSourceBlock,
  buildApiSourceBlock,
  buildWiringSourceBlock,
  findEntryCandidates,
  MAX_FILE_BYTES,
} from '../lib/inline-source.js';

let dir;

function write(rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return rel;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restless-inline-'));
});
afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe('rankSourceFiles', () => {
  it('puts the seeds first, in the order given', () => {
    write('a.js', '//a');
    write('b.js', '//b');
    expect(rankSourceFiles(dir, { seedFiles: ['b.js', 'a.js'] })).toEqual(['b.js', 'a.js']);
  });

  it('follows relative imports out of a seed', () => {
    write('routes.js', "import { schema } from './schema.js';\nconst x = 1;");
    write('schema.js', 'export const schema = {};');
    expect(rankSourceFiles(dir, { seedFiles: ['routes.js'] })).toEqual(['routes.js', 'schema.js']);
  });

  it('follows two hops by default, breadth-first', () => {
    // The real shape this exists for: a route file imports a per-resource
    // schema, which imports a shared one. One hop would miss the shared file.
    write('routes.js', "import s from './schema.js';");
    write('schema.js', "import c from './common.js';");
    write('common.js', 'export default {};');
    expect(rankSourceFiles(dir, { seedFiles: ['routes.js'] }))
      .toEqual(['routes.js', 'schema.js', 'common.js']);
  });

  it('stops at the requested depth', () => {
    write('routes.js', "import s from './schema.js';");
    write('schema.js', "import c from './common.js';");
    write('common.js', 'export default {};');
    expect(rankSourceFiles(dir, { seedFiles: ['routes.js'], hops: 1 }))
      .toEqual(['routes.js', 'schema.js']);
  });

  it('survives an import cycle', () => {
    write('a.js', "import b from './b.js';");
    write('b.js', "import a from './a.js';");
    expect(rankSourceFiles(dir, { seedFiles: ['a.js'], hops: 5 })).toEqual(['a.js', 'b.js']);
  });

  it('resolves directory imports through index files', () => {
    write('app.js', "import routes from './routes';");
    write('routes/index.js', 'export default [];');
    expect(rankSourceFiles(dir, { seedFiles: ['app.js'] })).toContain('routes/index.js');
  });

  it('ignores bare-module imports', () => {
    write('app.js', "import express from 'express';\nimport path from 'node:path';");
    expect(rankSourceFiles(dir, { seedFiles: ['app.js'] })).toEqual(['app.js']);
  });

  it('resolves CommonJS requires', () => {
    write('app.js', "const r = require('./routes.js');");
    write('routes.js', 'module.exports = {};');
    expect(rankSourceFiles(dir, { seedFiles: ['app.js'] })).toContain('routes.js');
  });

  it('resolves Python package-relative imports', () => {
    write('api/views.py', 'from .serializers import Thing\n');
    write('api/serializers.py', 'class Thing: pass\n');
    expect(rankSourceFiles(dir, { seedFiles: ['api/views.py'] })).toContain('api/serializers.py');
  });

  it('resolves Ruby require_relative', () => {
    write('app.rb', "require_relative 'models/user'\n");
    write('models/user.rb', 'class User; end\n');
    expect(rankSourceFiles(dir, { seedFiles: ['app.rb'] })).toContain('models/user.rb');
  });

  it('never escapes the root via ../ imports', () => {
    write('pkg/app.js', "import secret from '../../outside.js';");
    write('outside.js', 'export default 1;');
    expect(rankSourceFiles(dir, { seedFiles: ['pkg/app.js'] })).toEqual(['pkg/app.js']);
  });

  it('skips files that are not source', () => {
    write('a.js', '//a');
    expect(rankSourceFiles(dir, { seedFiles: ['a.js', 'README.md', 'data.json'] })).toEqual(['a.js']);
  });

  it('ranks shape-named extras ahead of other extras', () => {
    write('routes.js', '//r');
    write('helpers.js', '//h');
    write('user.schema.js', '//s');
    expect(rankSourceFiles(dir, { seedFiles: ['routes.js'], extraFiles: ['helpers.js', 'user.schema.js'] }))
      .toEqual(['routes.js', 'user.schema.js', 'helpers.js']);
  });
});

describe('buildSourceBlock', () => {
  it('inlines file contents under their path', () => {
    write('src/app.js', 'const app = 1;');
    const { block, included, bytes } = buildSourceBlock(dir, { seedFiles: ['src/app.js'] });
    expect(included).toEqual(['src/app.js']);
    expect(bytes).toBe('const app = 1;'.length);
    expect(block).toContain('### src/app.js');
    expect(block).toContain('const app = 1;');
    expect(block).toContain('Do not re-read');
  });

  it('returns an empty block when there is nothing to inline', () => {
    // The prompt interpolates this unconditionally, so the no-seed case has
    // to render exactly the prompt that shipped before any of this existed.
    expect(buildSourceBlock(dir, { seedFiles: [] })).toMatchObject({ block: '', included: [], bytes: 0 });
  });

  it('stops at the byte budget and names what it dropped', () => {
    write('a.js', 'x'.repeat(400));
    write('b.js', 'y'.repeat(400));
    const { included, omitted } = buildSourceBlock(dir, {
      seedFiles: ['a.js', 'b.js'],
      budgetBytes: 500,
    });
    expect(included).toEqual(['a.js']);
    expect(omitted).toEqual(['b.js']);
  });

  it('tells the model which files it left out', () => {
    write('a.js', 'x'.repeat(400));
    write('b.js', 'y'.repeat(400));
    const { block } = buildSourceBlock(dir, { seedFiles: ['a.js', 'b.js'], budgetBytes: 500 });
    expect(block).toContain('Not included');
    expect(block).toContain('b.js');
  });

  it('skips a single file bigger than the per-file ceiling', () => {
    // A bundle or a generated client would otherwise eat the whole budget.
    write('bundle.js', 'z'.repeat(MAX_FILE_BYTES + 1));
    write('small.js', 'ok');
    const { included, omitted } = buildSourceBlock(dir, { seedFiles: ['bundle.js', 'small.js'] });
    expect(included).toEqual(['small.js']);
    expect(omitted).toEqual(['bundle.js']);
  });

  it('skips a missing file without throwing', () => {
    write('real.js', 'ok');
    const { included } = buildSourceBlock(dir, { seedFiles: ['gone.js', 'real.js'] });
    expect(included).toEqual(['real.js']);
  });

  it('spends the budget in priority order, so route files always make it', () => {
    write('routes.js', "import s from './schema.js';\n" + 'r'.repeat(300));
    write('schema.js', 's'.repeat(400));
    const { included } = buildSourceBlock(dir, { seedFiles: ['routes.js'], budgetBytes: 400 });
    expect(included).toEqual(['routes.js']);
  });
});

describe('findEntryCandidates', () => {
  it('finds conventional entry files at the root and one level deep', () => {
    write('src/index.js', '//i');
    write('src/app.js', '//a');
    write('server.js', '//s');
    write('src/routes/thing.js', '//t');
    const found = findEntryCandidates(dir);
    expect(found).toContain('server.js');
    expect(found).toContain('src/index.js');
    expect(found).toContain('src/app.js');
    expect(found).not.toContain('src/routes/thing.js');
  });

  it('returns an empty list for a directory with no entry file', () => {
    write('src/routes/thing.js', '//t');
    expect(findEntryCandidates(dir)).toEqual([]);
  });
});

describe('buildWiringSourceBlock', () => {
  it('ranks the entry file ahead of the route files', () => {
    // The wiring step edits the entry file, so it would rather lose a route
    // file to the budget than the file it is about to change.
    write('src/app.js', "import express from 'express';\nconst app = express();");
    write('src/routes/user.js', "router.get('/users', h);");
    const { included } = buildWiringSourceBlock(dir, { languages: ['javascript'] });
    expect(included[0]).toBe('src/app.js');
    expect(included).toContain('src/routes/user.js');
  });
});

describe('buildApiSourceBlock', () => {
  it('seeds from the files the deterministic scan found routes in', () => {
    write('package.json', JSON.stringify({ dependencies: { express: '^4' } }));
    write('src/routes/user.js', "import { s } from '../schemas/user.js';\nrouter.get('/users', h);");
    write('src/schemas/user.js', 'export const s = {};');
    const { included } = buildApiSourceBlock(dir, { languages: ['javascript'] });
    expect(included).toContain('src/routes/user.js');
    expect(included).toContain('src/schemas/user.js');
  });

  it('yields an empty block when no routes are found, so the model explores as before', () => {
    write('README.md', '# nothing here');
    expect(buildApiSourceBlock(dir, { languages: ['javascript'] }).block).toBe('');
  });

  it('does not throw on an unreadable directory', () => {
    expect(() => buildApiSourceBlock(path.join(dir, 'nope'), { languages: ['javascript'] })).not.toThrow();
  });
});
