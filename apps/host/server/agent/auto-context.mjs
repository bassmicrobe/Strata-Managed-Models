import { isContextOverflow } from './context-budget.mjs';

export const MAX_CONTEXT_RECOVERIES = 2;
export const CONTEXT_CONTINUE = 'Continue the unfinished request from the compacted conversation. Keep completed work and tool results; do not repeat a completed command or edit. If the request is already complete, give its final answer. Do not ask the user to repeat the request.';

/** Only an explicitly known capacity may be used to judge pressure. */
export const hasKnownContext = route => route?.contextWindow > 0 && (route.kind === 'local' || route.contextKnown === true);

export function needsContextRecovery({ ended, wrote, tokens, window }) {
  if (ended?.kind === 'error') return isContextOverflow(ended.error ?? ended.failure);
  return !wrote && ['completed', 'max-tokens'].includes(ended?.kind) && window > 0 && Number(tokens) >= window * 0.85;
}

/**
 * Last-resort recovery after the Harness's own bounded in-turn recovery ended.
 * The caller keeps its UI turn open. Never replay the submitted user message or
 * tool calls: the existing durable session receives one continuation only after
 * a successful, measurable reduction. A failed attempt is also bounded.
 */
export async function recoverContext({ state, compact, resume, stopped = () => false }) {
  if (state.running || stopped() || (state.attempts ?? 0) >= MAX_CONTEXT_RECOVERIES) return { resumed: false, reason: 'limited' };
  state.running = true;
  state.attempts = (state.attempts ?? 0) + 1;
  try {
    const result = await compact();
    if (stopped()) return { resumed: false, reason: 'stopped' };
    const before = result?.before?.tokens, after = result?.after?.tokens;
    if (!result?.ok || !Number.isFinite(before) || !Number.isFinite(after) || after >= before) return { resumed: false, reason: 'no-progress' };
    await resume(result);
    return { resumed: true, result };
  } catch (error) {
    return { resumed: false, reason: stopped() ? 'stopped' : 'failed', error };
  } finally { state.running = false; }
}
