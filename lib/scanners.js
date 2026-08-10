import { getSdkWriter, isSupportedLanguage, normalizeLanguage } from './sdk-writers/index.js';

/**
 * Run the deterministic pre-scan for one or more languages and merge the
 * findings.
 *
 * Which scan belongs to which language is not written down here. It used to be
 * a `SCANNERS` table keyed by language name, which is the writer registry's
 * dispatch rebuilt beside it - and unlike the registry, nothing checked it, so
 * a language with a writer but no entry silently scanned as nothing at all.
 * `writer.scanCodebase` is a required method, so that cannot happen.
 *
 * Every scanner returns the same shape:
 *
 *   { endpoints, filesWithEndpoints, scannedFileCount, frameworkSignals }
 *
 * which is what lets `scanFor` merge several without the findings renderer
 * knowing how many ran.
 */

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
    // An unsupported language reaching here is not an error worth throwing
    // over: callers pass whatever detection produced, and the point of the
    // merge is to gather what we can.
    if (!isSupportedLanguage(language)) continue;
    let result;
    try {
      result = getSdkWriter(language).scanCodebase(rootDir);
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
