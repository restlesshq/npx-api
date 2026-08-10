import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { detectStack, describeLanguages, unsupportedStackMessage, stackCheckDisabled } from '../lib/detect-stack.js';

function tmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'detect-stack-')));
}

function write(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function pkg(deps = {}, extra = {}) {
  return JSON.stringify({ name: 'x', dependencies: deps, ...extra });
}

describe('detectStack', () => {
  let dir;
  beforeEach(() => {
    dir = tmp();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('blocks a repo with no Node server', () => {
    it('flags a pure Python project', () => {
      write(dir, 'requirements.txt', 'fastapi==0.110\nuvicorn\n');
      write(dir, 'main.py', 'app = FastAPI()\n');
      const stack = detectStack(dir);
      expect(stack.supported).toBe(false);
      expect(stack.languages).toEqual(['Python']);
    });

    it('flags a Django backend with a React frontend - the case the prompt guard missed', () => {
      // The old guard in prompts/detect-endpoints.md required "no package.json
      // exists", so this shape sailed straight past it and the LLM would label
      // the frontend as the API.
      write(dir, 'backend/requirements.txt', 'django\n');
      write(dir, 'backend/manage.py', '#!/usr/bin/env python\n');
      write(dir, 'frontend/package.json', pkg({ react: '^18', 'react-dom': '^18', vite: '^5' }));
      write(dir, 'frontend/src/App.jsx', 'export default function App() { return null; }\n');
      const stack = detectStack(dir);
      expect(stack.supported).toBe(false);
      expect(stack.languages).toEqual(['Python']);
      expect(stack.foreign[0].files.sort()).toEqual([
        path.join('backend', 'manage.py'),
        path.join('backend', 'requirements.txt'),
      ]);
    });

    it('flags Go, Ruby, PHP, Rust, Java and .NET projects', () => {
      const cases = [
        ['go.mod', 'module example.com/api\n', 'Go'],
        ['Gemfile', "source 'https://rubygems.org'\ngem 'rails'\n", 'Ruby'],
        ['composer.json', '{"require":{"laravel/framework":"^11"}}', 'PHP'],
        ['Cargo.toml', '[package]\nname = "api"\n', 'Rust'],
        ['pom.xml', '<project></project>', 'Java'],
        ['Api.csproj', '<Project></Project>', '.NET'],
        ['mix.exs', 'defmodule Api.MixProject do\nend\n', 'Elixir'],
      ];
      for (const [file, content, language] of cases) {
        const d = tmp();
        try {
          write(d, file, content);
          const stack = detectStack(d);
          expect(stack.supported, `${file} should be unsupported`).toBe(false);
          expect(stack.languages).toEqual([language]);
        } finally {
          fs.rmSync(d, { recursive: true, force: true });
        }
      }
    });

    it('orders mixed foreign stacks by how much evidence each has', () => {
      write(dir, 'services/py/requirements.txt', 'flask\n');
      write(dir, 'services/py/pyproject.toml', '[project]\nname="svc"\n');
      write(dir, 'services/py/setup.py', 'setup()\n');
      write(dir, 'services/go/go.mod', 'module x\n');
      const stack = detectStack(dir);
      expect(stack.supported).toBe(false);
      expect(stack.languages).toEqual(['Python', 'Go']);
    });
  });

  describe('never blocks a repo that might be Node', () => {
    it('allows a Node API that happens to carry a requirements.txt', () => {
      // Plenty of Node repos keep Python around for scripts or docs tooling.
      write(dir, 'package.json', pkg({ express: '^4' }));
      write(dir, 'src/server.js', "const app = express();\napp.get('/pets', h);\n");
      write(dir, 'scripts/requirements.txt', 'requests\n');
      const stack = detectStack(dir);
      expect(stack.supported).toBe(true);
      expect(stack.nodeEvidence.join(' ')).toContain('express');
    });

    it('allows a framework outside the labelling list (polka, h3, Elysia)', () => {
      for (const dep of ['polka', 'h3', 'elysia', 'graphql-yoga', '@trpc/server', '@sveltejs/kit']) {
        const d = tmp();
        try {
          write(d, 'package.json', pkg({ [dep]: '^1' }));
          write(d, 'go.mod', 'module x\n');
          const stack = detectStack(d);
          expect(stack.supported, `${dep} should count as Node`).toBe(true);
        } finally {
          fs.rmSync(d, { recursive: true, force: true });
        }
      }
    });

    it('allows a bare node:http server with no framework dependency at all', () => {
      // No recognizable dep and no matched route - only the source marker
      // stands between this repo and a wrong "we do not support Ruby" exit.
      write(dir, 'package.json', pkg({}));
      write(dir, 'Gemfile', "source 'https://rubygems.org'\n");
      write(dir, 'server.mjs', "import { createServer } from 'node:http';\ncreateServer(handler).listen(3000);\n");
      const stack = detectStack(dir);
      expect(stack.supported).toBe(true);
      expect(stack.nodeEvidence.join(' ')).toContain('Node server code');
    });

    it('allows a repo whose only Node evidence is a matched route', () => {
      write(dir, 'package.json', pkg({}));
      write(dir, 'pyproject.toml', '[project]\nname="tooling"\n');
      write(dir, 'src/routes.ts', "router.get('/health', h);\nrouter.post('/pets', h);\n");
      const stack = detectStack(dir);
      expect(stack.supported).toBe(true);
      expect(stack.nodeEvidence.join(' ')).toMatch(/route/);
    });

    it('stays out of the way when there is no foreign manifest', () => {
      // An empty or unrecognizable repo keeps the old behaviour (the picker's
      // hint loop), which is correct for a Node repo we simply failed to read.
      const stack = detectStack(dir);
      expect(stack.supported).toBe(true);
      expect(stack.foreign).toEqual([]);
    });

    it('ignores foreign manifests inside vendored dependency trees', () => {
      // A checked-in virtualenv or bundled gems must not make a Node repo Python.
      write(dir, 'package.json', pkg({}));
      write(dir, 'index.js', 'console.log(1);\n');
      write(dir, '.venv/lib/python3.12/site-packages/thing/pyproject.toml', '[project]\n');
      write(dir, 'vendor/bundle/ruby/3.3/gems/rack/Gemfile', 'source "x"\n');
      write(dir, 'node_modules/some-dep/requirements.txt', 'x\n');
      const stack = detectStack(dir);
      expect(stack.foreign).toEqual([]);
      expect(stack.supported).toBe(true);
    });

    it('counts a Next.js app as Node', () => {
      write(dir, 'package.json', pkg({ next: '^15', react: '^19' }));
      write(dir, 'app/api/pets/route.ts', 'export async function GET() {}\n');
      write(dir, 'requirements.txt', 'jupyter\n');
      const stack = detectStack(dir);
      expect(stack.supported).toBe(true);
    });

    it('counts a server dep declared only in devDependencies', () => {
      write(dir, 'package.json', JSON.stringify({ name: 'x', devDependencies: { fastify: '^4' } }));
      write(dir, 'go.mod', 'module x\n');
      expect(detectStack(dir).supported).toBe(true);
    });
  });
});

describe('describeLanguages', () => {
  it('reads as prose for one, two and three languages', () => {
    expect(describeLanguages(['Python'])).toBe('Python');
    expect(describeLanguages(['Python', 'Go'])).toBe('Python and Go');
    expect(describeLanguages(['Python', 'Go', 'Rust'])).toBe('Python, Go and Rust');
    expect(describeLanguages([])).toBe('another language');
  });
});

describe('unsupportedStackMessage', () => {
  it('names the language, cites the files, and documents the escape hatch', () => {
    const stack = {
      supported: false,
      nodeEvidence: [],
      foreign: [{ language: 'Python', files: ['backend/requirements.txt', 'backend/manage.py'] }],
      languages: ['Python'],
    };
    const { headline, details } = unsupportedStackMessage(stack, { rootDir: '/repo', cliName: 'api' });
    expect(headline).toContain('a Python project');
    const body = details.join('\n');
    expect(body).toContain('backend/requirements.txt');
    expect(body).toContain('/repo');
    expect(body).toContain('RESTLESS_SKIP_STACK_CHECK=1 npx api init');
  });

  it('calls a multi-language repo mixed rather than guessing one', () => {
    const stack = {
      supported: false,
      nodeEvidence: [],
      foreign: [
        { language: 'Python', files: ['a/requirements.txt'] },
        { language: 'Go', files: ['b/go.mod'] },
      ],
      languages: ['Python', 'Go'],
    };
    const { headline } = unsupportedStackMessage(stack, { rootDir: '/repo' });
    expect(headline).toContain('a mixed project');
  });

  it('truncates a long evidence list', () => {
    const files = Array.from({ length: 9 }, (_, i) => `svc${i}/go.mod`);
    const { details } = unsupportedStackMessage(
      { supported: false, nodeEvidence: [], foreign: [{ language: 'Go', files }], languages: ['Go'] },
      { rootDir: '/repo' },
    );
    expect(details[0]).toContain('…');
  });
});

describe('stackCheckDisabled', () => {
  const original = process.env.RESTLESS_SKIP_STACK_CHECK;
  afterEach(() => {
    if (original === undefined) delete process.env.RESTLESS_SKIP_STACK_CHECK;
    else process.env.RESTLESS_SKIP_STACK_CHECK = original;
  });

  it('is off by default and honors the documented value', () => {
    delete process.env.RESTLESS_SKIP_STACK_CHECK;
    expect(stackCheckDisabled()).toBe(false);
    process.env.RESTLESS_SKIP_STACK_CHECK = '1';
    expect(stackCheckDisabled()).toBe(true);
    process.env.RESTLESS_SKIP_STACK_CHECK = 'true';
    expect(stackCheckDisabled()).toBe(false);
  });
});
