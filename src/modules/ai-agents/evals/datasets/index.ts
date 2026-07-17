import type { EvalDataset } from '../types';

/**
 * Catalog of eval datasets keyed by canonical agent name.
 *
 * Keys MUST match `EvalDataset.agentName` exactly so the runner can lookup
 * the dataset by the agent under test without ambiguity.
 *
 * Vazio de propósito (2026-07-16): os datasets herdados testavam os agentes
 * do negócio anterior (Bravy). Os evals da Exatek serão construídos a partir
 * de conversas reais quando a IA for religada — ver docs/PLANO-IA-V2.md.
 */
export const datasets: Record<string, EvalDataset> = {};
