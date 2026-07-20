/**
 * Tipos canônicos do Intent Classifier.
 *
 * O classifier roda ANTES do orchestrator e usa Haiku pra decidir qual
 * worker chamar quando dá pra ter certeza. Isso economiza ~40% de custo
 * + ~1.5s de latência em mensagens onde o roteamento é óbvio.
 *
 * DATA-DRIVEN: os destinos possíveis NÃO são fixos no código — são os
 * workers ativos da org (id + nome + descrição), carregados do banco e
 * injetados no prompt em runtime. O modelo devolve o ID do agente, nunca
 * um nome chumbado.
 *
 * Mensagens com intent ambíguo, small talk, spam ou pedido de escalação
 * caem de volta no orchestrator (skippedOrchestrator=false), que continua
 * sendo o caminho seguro pra qualquer coisa fora-da-curva.
 */

export enum IntentType {
  /** Caso claro de um dos workers listados → vai direto pro agente sugerido */
  ROUTE_TO_AGENT = 'ROUTE_TO_AGENT',
  /** Oi/bom dia/agradecimento → orchestrator responde direto */
  SMALL_TALK = 'SMALL_TALK',
  /** Não dá pra decidir → orchestrator resolve */
  AMBIGUOUS = 'AMBIGUOUS',
  /** Spam, áudio sem transcrição, link suspeito → orchestrator decide ação */
  SPAM_OR_NOISE = 'SPAM_OR_NOISE',
  /** Cliente irritado/ameaça/situação grave → transfere pra humano */
  ESCALATE_HUMAN = 'ESCALATE_HUMAN',
}

/** Worker roteável da org — carregado do banco pelo AgentRouter. */
export interface RoutableAgent {
  id: string;
  name: string;
  /** O que esse agente atende (AiAgent.description). Vazio = só o nome. */
  description: string | null;
}

/** Mensagem do histórico recente passada como contexto ao classifier. */
export interface ClassifierMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ClassificationResult {
  intent: IntentType;
  /** 0.0 — 1.0. Abaixo do threshold cai pro orchestrator. */
  confidence: number;
  /** Explicação curta do Haiku — útil pra debug e auditoria. */
  reasoning: string;
  /** ID do worker sugerido (validado contra a lista da org) — null quando
   *  o intent vai pro orchestrator. */
  suggestedAgentId: string | null;
  /** true quando confidence >= threshold E intent é ROUTE_TO_AGENT com
   *  suggestedAgentId válido. */
  skippedOrchestrator: boolean;
  /** ID do modelo realmente usado (ex.: 'claude-haiku-4-5'). */
  modelUsed: string;
  /** Custo desta classificação em USD. */
  costUsd: number;
  /** Latência total da chamada em ms. */
  durationMs: number;
}

export interface ClassifierConfig {
  /** Default 0.85. Abaixo disso → fallback pro orchestrator. */
  threshold: number;
  /** Default 'claude-haiku-4-5'. */
  model: string;
}
