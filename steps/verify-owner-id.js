import fs from 'fs';
import path from 'path';
import { runAI, loadPrompt } from '../lib/ai.js';
import { bold, dim, green, yellow, cyan, orange } from '../lib/ui.js';
import * as debug from '../lib/debug.js';
import { getSdkWriter } from '../lib/sdk-writers/index.js';
import { nextPluginWiringStatus } from '../lib/next-detect.js';
import { analyzeOwnerId } from './final-checks.js';

/**
 * Find the wired source file by grepping for the SDK import. Same
 * approach as final-checks / install-sdk: writer.hasInit() confirms the
 * file actually plumbs the SDK in, not just mentions it.
 *
 * Plugin-style Next wiring has no factory call, so hasInit() never
 * matches it - the setup callback (and its owner.id) lives in
 * restless.config.*, which we resolve directly.
 */
function findWiredSourceFile(installDir, language) {
  const plugin = nextPluginWiringStatus(installDir);
  if (plugin.hasDefineConfig) {
    return path.join(installDir, plugin.restlessConfigFile);
  }
  const writer = getSdkWriter(language);
  const candidates = writer.candidateWiringFiles(installDir);
  for (const rel of candidates) {
    const abs = path.join(installDir, rel);
    try {
      const content = fs.readFileSync(abs, 'utf8');
      if (writer.hasInit(content)) return abs;
    } catch {}
  }
  return null;
}

/**
 * Semantic verification pass for owner.id. Runs between install-sdk and
 * final-checks, as a security gate: the AI's domain knowledge of the
 * codebase says whether the field it (or a prior run) picked is actually
 * server-verified and immutable.
 *
 * Strategy: hand the AI a focused prompt that tells it to either confirm
 * the current owner.id is safe, or replace it with the NEEDS_CONFIGURATION
 * sentinel. Either way the static check + interactive repair in
 * final-checks picks up from there.
 *
 * Why a separate AI pass instead of bundling into install-sdk:
 *   - Install-sdk's prompt is already long. Splitting "wire it in" from
 *     "verify it" keeps each turn focused.
 *   - A verify-only prompt can be strict in a way the install prompt
 *     can't be: it gets to see what was actually written, second-guess
 *     it, and rewrite to the sentinel without producing other text.
 *   - Past bug class: AI writes wiring confidently with a plausible-looking
 *     `req.body.tenantId`. Static check passes (heuristic doesn't catch
 *     "this is user-controlled in this codebase"). This pass exists to
 *     catch that.
 *
 * Skips work when:
 *   - There's no wired file (install-sdk would have already aborted).
 *   - The current owner.id is the sentinel (the repair flow will fire).
 *   - Static analysis already flags critical (same reason).
 */
export default async function verifyOwnerId({ ctx, update, setSpinner }) {
  const { installDir, language = 'javascript', framework, aiTool = 'Claude Code' } = ctx;
  const writer = getSdkWriter(language);
  const sourceFile = findWiredSourceFile(installDir, language);

  if (!sourceFile) {
    debug.log('verify-owner-id.no-source');
    return { ran: false, reason: 'no-source' };
  }

  const before = fs.readFileSync(sourceFile, 'utf8');
  const fields = writer.readBlockFields(before);
  const analysis = analyzeOwnerId(fields.ownerIdExpr);

  // If the static heuristic already says critical, the repair flow in
  // final-checks will fire. No need to spend an AI turn here.
  if (analysis.severity === 'critical') {
    debug.log('verify-owner-id.skipped', {
      reason: 'static-already-critical',
      ownerIdExpr: fields.ownerIdExpr,
      analysisReason: analysis.reason,
    });
    return { ran: false, reason: 'static-critical', analysis };
  }

  update({ message: [
    `  Verifying ${bold('owner.id')} is a stable, immutable identifier.`,
    `  ${orange(aiTool)} ${dim('is tracing the data flow and checking your schema. This is a security check.')}`,
  ]});

  const prompt = loadPrompt('verify-owner-id', {
    language,
    framework: framework || language,
  });

  try {
    await runAI(prompt, installDir, { setSpinner });
  } catch (err) {
    debug.log('verify-owner-id.ai-error', { message: err.message });
    update({ message: [
      `  ${yellow('⚠')} ${orange(aiTool)} couldn't complete the verification pass: ${err.message}`,
      dim('  Continuing to final checks - the static check will still run.'),
    ]});
    return { ran: true, reason: 'ai-error' };
  }

  const after = fs.readFileSync(sourceFile, 'utf8');
  const afterFields = writer.readBlockFields(after);
  const afterAnalysis = analyzeOwnerId(afterFields.ownerIdExpr);
  const changed = before !== after;
  const downgraded = changed && afterAnalysis.severity !== 'ok';

  debug.log('verify-owner-id.done', {
    changed,
    before: { expr: fields.ownerIdExpr, severity: analysis.severity },
    after: { expr: afterFields.ownerIdExpr, severity: afterAnalysis.severity },
  });

  if (!changed && analysis.severity === 'ok') {
    update({ message: [
      `  ${green('✓')} ${bold('owner.id')} verified: ${cyan(fields.ownerIdExpr)}`,
    ]});
  } else if (downgraded) {
    update({ message: [
      `  ${yellow('⚠')} ${orange(aiTool)} couldn't confirm the previous ${bold('owner.id')} (${cyan(fields.ownerIdExpr || '(none)')}) is safe.`,
      dim('  It rewrote the field to the configuration sentinel; final-checks will prompt you to pick one.'),
    ]});
  } else if (changed) {
    update({ message: [
      `  ${green('✓')} ${bold('owner.id')} adjusted: ${cyan(afterFields.ownerIdExpr)}`,
    ]});
  } else {
    // changed=false, severity=warning. The AI looked at it and chose
    // not to downgrade. Static check will still fire in final-checks
    // and ask the user to confirm.
    update({ message: [
      `  ${yellow('⚠')} ${bold('owner.id')} (${cyan(fields.ownerIdExpr)}) needs your confirmation.`,
      dim(`  ${analysis.reason}`),
    ]});
  }

  return { ran: true, changed, before: analysis, after: afterAnalysis };
}
