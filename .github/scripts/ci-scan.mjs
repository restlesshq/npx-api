// Deterministic pre-check. No model, no secrets, no network beyond `gh api`.
//
// This runs BEFORE (and independently of) the AI reviewer. Everything here is a
// mechanical signal from the 2026-08-23 supply-chain incident, chosen because it
// is cheap, has no false-negative mode, and cannot be talked out of a verdict by
// text in the diff. The AI reviewer stays in place for everything this can't see.
//
// Env: BASE_SHA, HEAD_SHA, EVENT (push|pull_request), FORCED (true|false),
//      REPO, GH_TOKEN.

import { execFileSync } from "node:child_process";

const { BASE_SHA, HEAD_SHA, EVENT, FORCED, REPO } = process.env;
const ZERO = "0000000000000000000000000000000000000000";
const findings = [];
const block = (rule, detail) => findings.push({ rule, detail });

const git = (args, opts = {}) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...opts });

const ghJSON = (path) => {
  try {
    return JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));
  } catch {
    return null;
  }
};

// Resolve a usable diff base. On a force push the previous tip is often
// unreachable from the checkout, so fall back to the merge-base with the
// default branch rather than silently diffing against nothing.
let base = BASE_SHA;
const usable = (sha) => {
  if (!sha || sha === ZERO) return false;
  try { git(["cat-file", "-e", `${sha}^{commit}`], { stdio: "ignore" }); return true; } catch { return false; }
};
if (!usable(base)) {
  try {
    const def = git(["symbolic-ref", "refs/remotes/origin/HEAD"]).trim().replace("refs/remotes/", "");
    base = git(["merge-base", def, HEAD_SHA]).trim();
  } catch { base = null; }
}

// ---------------------------------------------------------------------------
// 1. Amend-in-place fingerprint (force pushes only).
// A rebase moves the parent. The worm kept the parent, changed the tree, and
// dropped the signature so `git log` looked untouched. That combination is not
// something a normal workflow produces.
// ---------------------------------------------------------------------------
if (EVENT === "push" && FORCED === "true" && BASE_SHA && BASE_SHA !== ZERO) {
  const before = ghJSON(`/repos/${REPO}/git/commits/${BASE_SHA}`);
  const after = ghJSON(`/repos/${REPO}/git/commits/${HEAD_SHA}`);
  if (before && after) {
    const sameParents =
      JSON.stringify(before.parents.map((p) => p.sha)) === JSON.stringify(after.parents.map((p) => p.sha));
    const treeChanged = before.tree.sha !== after.tree.sha;
    const sigDropped = before.verification?.verified === true && after.verification?.verified !== true;
    if (sameParents && treeChanged) {
      block(
        "amend-in-place",
        `Force push kept the same parent (${before.parents.map((p) => p.sha.slice(0, 7)).join(",") || "root"}) ` +
          `but changed the tree (${before.tree.sha.slice(0, 7)} -> ${after.tree.sha.slice(0, 7)})` +
          (sigDropped ? ", and dropped a previously valid signature" : "") +
          ". A rebase moves the parent; this rewrote content in place.",
      );
    } else if (sigDropped) {
      block("signature-dropped", `Force push replaced a signed commit with an unsigned one.`);
    }
  }
}

if (!base) {
  console.log("No usable diff base (new branch with no history?). Skipping diff checks.");
} else {
  const nameStatus = git(["diff", "--name-status", "-z", base, HEAD_SHA]).split("\0").filter(Boolean);
  const changed = [];
  for (let i = 0; i < nameStatus.length; ) {
    const status = nameStatus[i++];
    if (status.startsWith("R") || status.startsWith("C")) { i++; changed.push({ status, path: nameStatus[i++] }); }
    else changed.push({ status, path: nameStatus[i++] });
  }

  const allChanged = new Set(changed.map((c) => c.path));
  // NOTE: `-w --name-only` does NOT filter the file list (git lists the file
  // regardless). `--numstat` does respect -w and omits whitespace-only files
  // entirely, so that is what we key off.
  const substantive = new Set(
    git(["diff", "-w", "--ignore-blank-lines", "--numstat", "-z", base, HEAD_SHA])
      .split("\0")
      .filter(Boolean)
      .map((rec) => rec.split("\t").pop())
      .filter(Boolean),
  );

  // -------------------------------------------------------------------------
  // 2. Mass whitespace / line-ending churn.
  // The attack rewrote every file to CRLF. That is camouflage: it inflates the
  // diff so the one real change is buried and the reviewer's budget is spent.
  // -------------------------------------------------------------------------
  const whitespaceOnly = [...allChanged].filter((p) => !substantive.has(p));
  if (whitespaceOnly.length > 5) {
    block(
      "mass-whitespace-churn",
      `${whitespaceOnly.length} files changed with no substantive content change (line endings or whitespace only). ` +
        `This is the camouflage pattern from the 2026-08-23 incident. Examples: ${whitespaceOnly.slice(0, 5).join(", ")}`,
    );
  }

  // -------------------------------------------------------------------------
  // 3. Auto-executing files that grew sharply.
  // postcss.config.mjs, next.config.js, src/app.ts and providers/claude.js each
  // took a ~30KB blob. These run on build or boot, with no import needed.
  // -------------------------------------------------------------------------
  const AUTO_EXEC = /(^|\/)((.*\.config\.(js|mjs|cjs|ts))|(next|postcss|tailwind|vite|webpack|rollup|svelte|astro)\.config\..*|app\.(ts|js|mjs)|index\.(ts|js|mjs)|server\.(ts|js|mjs)|main\.(ts|js|mjs))$/;
  const BIN_OR_ENTRY = /(^|\/)(bin|providers|scripts)\//;
  const GROWTH_LIMIT = 5000;

  // stderr silenced: `git show` is noisy about paths that don't exist at a rev,
  // which is an expected case here (added files), not an error worth printing.
  const sizeOf = (rev, path) => {
    try {
      return Buffer.byteLength(
        git(["show", `${rev}:${path}`], { maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }),
      );
    } catch { return 0; }
  };

  for (const { path } of changed) {
    if (!AUTO_EXEC.test(path) && !BIN_OR_ENTRY.test(path)) continue;
    // CI tooling legitimately lives in .github/scripts/ and is not an app
    // entrypoint. Payloads hidden there are still caught by minified-blob.
    if (path.startsWith(".github/")) continue;
    const wasThere = sizeOf(base, path);
    // Growth, not addition. A brand-new file has no "growth" to measure, and
    // reporting its full size as a delta flags every legitimate new module.
    // An added file carrying a payload is caught by minified-blob instead.
    if (wasThere === 0) continue;
    const grew = sizeOf(HEAD_SHA, path) - wasThere;
    if (grew > GROWTH_LIMIT) {
      block("auto-exec-bloat", `${path} grew by ${grew} bytes. Files that execute on build or boot should not gain bulk code in a single change.`);
    }
  }

  // -------------------------------------------------------------------------
  // 4. .gitignore losing its env protection.
  // The worm removed `.env*` so its planted .env would commit. Caught by the AI
  // reviewer as a warning; it deserves to be blocking and deterministic.
  // -------------------------------------------------------------------------
  // Compare normalised rule SETS, not raw diff lines. A CRLF rewrite shows every
  // line as removed-and-readded, which would otherwise fire on every file.
  const rules = (rev, path) => {
    let raw;
    try { raw = git(["show", `${rev}:${path}`]); } catch { return new Set(); }
    return new Set(raw.split("\n").map((l) => l.replace(/\r$/, "").trim()).filter((l) => l && !l.startsWith("#")));
  };
  for (const { path } of changed) {
    if (!/(^|\/)\.gitignore$/.test(path)) continue;
    const before = rules(base, path);
    const after = rules(HEAD_SHA, path);
    const lost = [...before].filter((r) => !after.has(r) && /\.?env/i.test(r));
    if (lost.length) block("gitignore-weakened", `${path} no longer ignores: ${lost.join(", ")}`);
  }

  // -------------------------------------------------------------------------
  // 5. A committed .env. Templates are fine; a real one is not.
  // -------------------------------------------------------------------------
  for (const { status, path } of changed) {
    if (!status.startsWith("A")) continue;
    const name = path.split("/").pop();
    if (/^\.env($|\.)/.test(name) && !/\.(example|sample|template|dist)$/.test(name)) {
      block("env-committed", `${path} was added. Committed env files leak secrets, and in this incident one carried the C2 address.`);
    }
  }

  // -------------------------------------------------------------------------
  // 6. Minified blob appended to hand-written source.
  // The payload was a single enormous line. Lockfiles and vendored/minified
  // assets legitimately look like this, so they're excluded.
  // -------------------------------------------------------------------------
  const EXEMPT = /(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|\.min\.(js|css)$|(^|\/)(dist|build|vendor|node_modules)\/|\.(map|svg|snap)$)/;
  const LONG_LINE = 1000;
  for (const { path } of changed) {
    if (EXEMPT.test(path)) continue;
    const added = git(["diff", "--unified=0", base, HEAD_SHA, "--", path])
      .split("\n")
      .filter((l) => l.startsWith("+") && !l.startsWith("+++"));
    const longest = added.reduce((m, l) => Math.max(m, l.length - 1), 0);
    if (longest > LONG_LINE) {
      block("minified-blob", `${path} added a single line of ${longest} characters. Obfuscated payloads look exactly like this.`);
    }
  }
}

// ---------------------------------------------------------------------------
if (!findings.length) {
  console.log("Deterministic scan passed: no incident-pattern signals.");
  process.exit(0);
}

console.error(`\n${"=".repeat(72)}\nDETERMINISTIC SECURITY SCAN FAILED: ${findings.length} signal(s)\n${"=".repeat(72)}\n`);
for (const f of findings) console.error(`  [${f.rule}]\n    ${f.detail}\n`);
console.error("These are mechanical checks, not model judgement. If a finding is a");
console.error("false positive, fix the rule in .github/scripts/ci-scan.mjs in its own");
console.error("PR rather than bypassing the check.\n");
process.exit(1);
