import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  guessBaseUrl,
  isPlausibleBaseUrl,
  checkOasServers,
  normalize,
  fromOas,
  fromFlyToml,
  fromRenderYaml,
  fromVercelJson,
  fromServerless,
  fromCompose,
  fromIngress,
  fromEnvTemplate,
  fromPackageJson,
  fromReadme,
} from '../lib/base-url.js';

let tmp;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'restless-baseurl-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const write = (rel, body) => {
  const full = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
};

describe('isPlausibleBaseUrl', () => {
  it('accepts a real host', () => {
    expect(isPlausibleBaseUrl('https://api.acme-corp.com')).toBe(true);
    expect(isPlausibleBaseUrl('http://staging.foo.io/api')).toBe(true);
  });

  it('rejects the things that show up in configs but are never an API', () => {
    for (const url of [
      'http://localhost:3000',
      'http://127.0.0.1:8080',
      'https://example.com',
      'https://github.com/acme/repo',
      'https://img.shields.io/badge/build-passing',
      'https://spec.openapis.org/oas/v3.0.0',
      'http://api.local',
      'http://backend', // container name, no dot
      'ftp://files.acme.com',
      'not a url',
      '',
      null,
    ]) {
      expect(isPlausibleBaseUrl(url), url).toBe(false);
    }
  });
});

describe('normalize', () => {
  it('drops trailing slashes and trailing punctuation from prose', () => {
    expect(normalize('https://api.acme.com/')).toBe('https://api.acme.com');
    expect(normalize('https://api.acme.com/v1//')).toBe('https://api.acme.com/v1');
    expect(normalize('https://api.acme.com).')).toBe('https://api.acme.com');
  });
});

describe('per-file parsers', () => {
  it('reads a fly app name into its fly.dev host', () => {
    expect(fromFlyToml('app = "benefits-api"\nprimary_region = "sjc"')).toBe('https://benefits-api.fly.dev');
  });

  it('reads a render web service name', () => {
    expect(fromRenderYaml('services:\n  - name: benefits-api\n    type: web\n')).toBe('https://benefits-api.onrender.com');
  });

  it('ignores a render file with no web service', () => {
    expect(fromRenderYaml('services:\n  - name: worker\n    type: worker\n')).toBeNull();
  });

  it('reads a vercel alias, with or without a scheme', () => {
    expect(fromVercelJson('{"alias":["api.acme.com"]}')).toBe('https://api.acme.com');
    expect(fromVercelJson('{"alias":"https://api.acme.com"}')).toBe('https://api.acme.com');
    expect(fromVercelJson('not json')).toBeNull();
  });

  it('reads a serverless custom domain', () => {
    expect(fromServerless('custom:\n  customDomain:\n    domainName: api.acme.com\n')).toBe('https://api.acme.com');
  });

  it('reads a traefik Host rule out of a compose file', () => {
    expect(fromCompose('labels:\n  - "traefik.http.routers.api.rule=Host(`api.acme.com`)"')).toBe('https://api.acme.com');
  });

  it('reads an ingress host, but only from an actual Ingress', () => {
    const ingress = 'kind: Ingress\nspec:\n  rules:\n    - host: api.acme.com\n';
    expect(fromIngress(ingress)).toBe('https://api.acme.com');
    expect(fromIngress('kind: Service\nspec:\n  rules:\n    - host: api.acme.com\n')).toBeNull();
  });

  it('prefers the most specific env key and skips localhost values', () => {
    const env = 'BASE_URL=http://localhost:3000\nAPI_BASE_URL=https://api.acme.com\n';
    expect(fromEnvTemplate(env)).toBe('https://api.acme.com');
    expect(fromEnvTemplate('BASE_URL=http://localhost:3000\n')).toBeNull();
  });

  it('reads package.json homepage', () => {
    expect(fromPackageJson('{"homepage":"https://api.acme.com"}')).toBe('https://api.acme.com');
  });

  it('picks an API-shaped URL out of a README, not the badges', () => {
    const readme = [
      '# Benefits API',
      '[![build](https://img.shields.io/badge/build-passing.svg)](https://github.com/acme/benefits)',
      'Docs live at https://acme.com/docs.',
      '```',
      'curl https://api.acme.com/v1/account -H "Authorization: Bearer x"',
      '```',
    ].join('\n');
    expect(fromReadme(readme)).toBe('https://api.acme.com/v1');
  });

  it('returns null for a README with nothing API-shaped', () => {
    expect(fromReadme('See https://acme.com for more.')).toBeNull();
  });

  it('takes servers[0] from a spec, skipping our own placeholder', () => {
    expect(fromOas({ servers: [{ url: 'https://api.acme.com/v2' }] })).toBe('https://api.acme.com/v2');
    expect(fromOas({ servers: [{ url: 'https://example.com' }] })).toBeNull();
    expect(fromOas({ servers: [{ url: 'https://example.com' }, { url: 'https://api.acme.com' }] })).toBe('https://api.acme.com');
    expect(fromOas(null)).toBeNull();
  });
});

describe('guessBaseUrl', () => {
  it('prefers a spec the user already has over anything in the repo', () => {
    write('fly.toml', 'app = "benefits-api"');
    const guess = guessBaseUrl({ dirs: [tmp], oas: { servers: [{ url: 'https://api.acme.com' }] } });
    expect(guess).toEqual({ url: 'https://api.acme.com', source: 'the spec' });
  });

  it('falls back to deploy manifests, and names the file it used', () => {
    write('fly.toml', 'app = "benefits-api"');
    expect(guessBaseUrl({ dirs: [tmp] })).toEqual({
      url: 'https://benefits-api.fly.dev',
      source: 'fly.toml',
    });
  });

  it('prefers a deploy manifest over a README URL', () => {
    write('README.md', 'curl https://api.acme.com/v1/things');
    write('render.yaml', 'services:\n  - name: benefits-api\n    type: web\n');
    expect(guessBaseUrl({ dirs: [tmp] }).source).toBe('render.yaml');
  });

  // A package's own deploy config beats the umbrella repo's docs.
  it('searches directories in the order given', () => {
    const pkg = path.join(tmp, 'services', 'api');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'fly.toml'), 'app = "the-api"');
    write('README.md', 'curl https://api.wrong.com/v1/things');
    expect(guessBaseUrl({ dirs: [pkg, tmp] }).url).toBe('https://the-api.fly.dev');
  });

  it('returns null when nothing plausible is around', () => {
    write('README.md', 'Run it locally at http://localhost:3000');
    write('.env.example', 'PORT=3000\n');
    expect(guessBaseUrl({ dirs: [tmp] })).toBeNull();
  });

  it('never reads a real .env', () => {
    write('.env', 'API_BASE_URL=https://secret.acme.com\n');
    expect(guessBaseUrl({ dirs: [tmp] })).toBeNull();
  });
});

describe('checkOasServers', () => {
  it('accepts a public URL and normalizes it', () => {
    const r = checkOasServers({ servers: [{ url: 'https://api.example.dev/v1/' }] });
    expect(r).toEqual({ ok: true, url: 'https://api.example.dev/v1' });
  });

  it('accepts relative servers as the honest no-public-URL form', () => {
    expect(checkOasServers({ servers: [{ url: '/v1' }] })).toMatchObject({ ok: true, relative: true });
  });

  it('accepts missing or empty servers', () => {
    expect(checkOasServers({}).ok).toBe(true);
    expect(checkOasServers({ servers: [] }).ok).toBe(true);
    expect(checkOasServers({ servers: [{ url: '' }] }).ok).toBe(true);
  });

  it('rejects localhost, loopback, private IPs, and container hosts', () => {
    for (const url of [
      'http://localhost:3002',
      'http://127.0.0.1:8080',
      'http://0.0.0.0:3000',
      'http://192.168.1.20:3000',
      'http://10.0.0.5',
      'http://172.16.0.2:9000',
      'http://api-container:8080',
      'http://myapp.internal',
    ]) {
      expect(checkOasServers({ servers: [{ url }] }).ok).toBe(false);
    }
  });
});
