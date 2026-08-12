import fs from 'fs';
import path from 'path';
import { getSdkWriter } from './sdk-writers/index.js';
import { nextPluginWiringStatus } from './next-detect.js';
import * as debug from './debug.js';

/**
 * Find the source file the SDK is actually wired into.
 *
 * There were three copies of this - `install-sdk.js`, `final-checks.js` and
 * `verify-owner-id.js` - each walking the writer's candidate files and testing
 * each one. The PR that introduced the writer registry deleted the triplicated
 * `getSdkWriter` from all three and left this, the larger duplicate, sitting
 * directly beneath it. The registry is what finally makes one version possible:
 * before it, each step had to resolve its own writer first.
 *
 * The variation between the three was real but small, and it is all here as
 * options:
 *
 *   `loose`     which predicate decides "wired". `hasInit` (default) requires
 *               an actual constructor call. `hasSdkReference` only requires the
 *               import, and final-checks wants that wider net specifically so
 *               it can FIND old-API files - they have the import but no factory
 *               call, so the strict check rejects exactly the files the old-API
 *               repair flow exists to rewrite.
 *   `entryFile` a file to prefer over the search, when the context already
 *               recorded where the wiring went.
 *   `plugin`    whether to short-circuit to the Next.js plugin config.
 *   `debugTag`  a namespace for the debug log, or null for no logging.
 */
export function findWiredSourceFile(installDir, language, {
  loose = false,
  entryFile = null,
  plugin = true,
  debugTag = null,
} = {}) {
  const writer = getSdkWriter(language);
  const isWired = (content) => (loose ? writer.hasSdkReference(content) : writer.hasInit(content));

  // Plugin-style Next wiring: the setup callback (credential + owner.id) lives
  // in restless.config.*, and that is the file the owner-id repair flows must
  // patch. Resolved directly because the search below would surface
  // next.config.* too (it also references the package), and which of the two
  // comes back first is up to grep's walk order.
  if (plugin) {
    const status = nextPluginWiringStatus(installDir);
    if (status.hasDefineConfig) return path.join(installDir, status.restlessConfigFile);
  }

  const read = (abs) => {
    try {
      return fs.readFileSync(abs, 'utf8');
    } catch {
      // Unreadable file - a common case is a grep match in a generated file
      // that is mid-rewrite.
      return null;
    }
  };

  // An entry file the context already knows about beats searching for one.
  if (entryFile) {
    const abs = path.isAbsolute(entryFile) ? entryFile : path.join(installDir, entryFile);
    const content = read(abs);
    if (content !== null && isWired(content)) return abs;
  }

  const candidates = writer.candidateWiringFiles(installDir);
  for (const rel of candidates) {
    const abs = path.join(installDir, rel);
    const content = read(abs);
    if (content !== null && isWired(content)) {
      if (debugTag) debug.log(`${debugTag}.wired-file`, { rel, candidates: candidates.length });
      return abs;
    }
  }

  // The search matched files but none of them are actually wired. Surface the
  // disagreement so it is visible in the debug log - most often a leftover
  // comment, JSDoc, or test fixture from a prior CLI run.
  if (debugTag && candidates.length > 0) {
    debug.log(`${debugTag}.stale-references`, { candidates });
  }
  return null;
}
