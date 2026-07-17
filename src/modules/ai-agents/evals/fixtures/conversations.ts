/**
 * Conversation history fixtures for evals.
 *
 * Each fixture id is referenced by EvalCase.conversationContext. The runner
 * is expected to load the matching turn list and feed it to the agent as
 * prior conversation context BEFORE running the eval input.
 *
 * Fixtures herdadas do negócio anterior removidas em 2026-07-16 — recriar
 * com cenários reais da Exatek junto com os novos datasets (PLANO-IA-V2.md).
 */

export interface FixtureTurn {
  role: 'user' | 'assistant';
  content: string;
}

export type FixtureId = never;

export const fixtures: Record<string, FixtureTurn[]> = {};
