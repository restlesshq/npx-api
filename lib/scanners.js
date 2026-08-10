import { scanCodebase } from './find-endpoints.js';
import { scanPythonCodebase } from './find-endpoints-python.js';
import { normalizeLanguage } from './sdk-writers/index.js';

/**
 * Which deterministic pre-scan runs for which language.
 *
 * Every scanner returns the same shape:
 *
 *   { endpoints, filesWithEndpoints, scannedFileCount, frameworkSignals }
 *
 * which is what lets `scanFor` below merge several without the findings
 * renderer knowing how many ran.
 */
const SCANNERS = {
  javascript: scanCodebase,
  typescript: scanCodebase,
  python: scanPythonCodebase,
};

/** Languages with a deterministic scanner, for tests and diagnostics. */
export const SCANNABLE_LANGUAGES = Object.keys(SCANNERS);

/**
 * Scan a directory as each of `languages` and merge the findings.
 *
 * Scanning more than one language is the normal case, not an edge case: a
 * Django API behind a Next.js frontend is two real APIs in one repo, and the
 * picker already exists to let the user choose between them. Merging rather
 * than picking a winner is what keeps the non-dominant one reachable - the
 * alternative is deciding for the user that their Python service does not
 * exist because a package.json turned up first.
 *
 * Endpoints and framework signals carry a `language`, so a detected API can
 * be routed to the right writer, guide and install command later even though
 * they were found in one pass.
 *
 * A scanner that throws is skipped rather than taking the run down with it.
 * The LLM exploration path downstream copes with empty findings; it cannot
 * cope with the process dying.
 */
export function scanFor(rootDir, languages = ['javascript']) {
  const wanted = [...new Set(
    (languages.length ? languages : ['javascript']).map(normalizeLanguage),
  )];

  const merged = {
    endpoints: [],
    filesWithEndpoints: [],
    scannedFileCount: 0,
    frameworkSignals: [],
  };

  for (const language of wanted) {
    const scan = SCANNERS[language];
    if (!scan) continue;
    let result;
    try {
      result = scan(rootDir);
    } catch {
      continue;
    }
    for (const e of result.endpoints) merged.endpoints.push({ ...e, language });
    merged.filesWithEndpoints.push(...result.filesWithEndpoints);
    merged.scannedFileCount += result.scannedFileCount;
    for (const s of result.frameworkSignals) {
      merged.frameworkSignals.push({ ...s, language });
    }
  }

  merged.filesWithEndpoints = [...new Set(merged.filesWithEndpoints)];
  return merged;
}
