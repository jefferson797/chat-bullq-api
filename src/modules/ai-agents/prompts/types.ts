/**
 * Tipos canônicos do Prompt Composer em 4 camadas.
 *
 * Arquitetura inspirada no BullQ (email marketing). Cada camada tem
 * responsabilidade única e ordem fixa:
 *
 *   1. SECURITY     — regras inegociáveis (sempre primeiro)
 *   2. PERSONALITY  — quem o agent é (do AiAgent.systemPrompt sanitizado)
 *   3. CAPABILITIES — o que ele pode fazer (skills + built-in tools)
 *   4. CONTEXT      — dados dinâmicos da conversa (cliente, hora, memória, catálogo)
 *
 * NOTA pra Agent 8 (Context Enricher): este arquivo é o contrato. O tipo
 * `EnrichedContext` é o que você precisa montar e devolver pro composer.
 * Não inventar campos novos — se precisar de algo a mais, abre RFC.
 */

export type LayerKind = 'security' | 'personality' | 'capabilities' | 'context';

/**
 * Resultado da construção de uma camada individual.
 * Cada layer service retorna isso e o composer concatena.
 */
export interface PromptLayer {
  kind: LayerKind;
  /** Texto formatado, já com cabeçalho (`=== ... ===`). */
  content: string;
  /** Estimativa grosseira: ~ chars / 4. Útil pra observabilidade. */
  tokenEstimate: number;
}

/**
 * Resultado final do compose() — system prompt pronto pra enviar ao LLM.
 */
export interface ComposedPrompt {
  /** String final, layers concatenadas com separador. */
  system: string;
  /** Soma dos tokenEstimates das layers. */
  totalTokens: number;
  /** Breakdown por layer (pra logs e dashboards). */
  layerBreakdown: Record<LayerKind, number>;
  /** Quando o compose foi chamado (UTC). */
  generatedAt: Date;
}

/**
 * Regras imutáveis de segurança. Aplicadas a TODO agent, sem exceção.
 *
 * Default: tudo `true`. Org pode adicionar `customRules` por cima — mas
 * NUNCA pode desligar uma regra default via override.
 */
export interface SecurityRules {
  /** Não prometer prazo específico de resultado ("em 7 dias", "em 30 dias"). */
  noPriceCommitment: boolean;
  /** Não prometer prazo específico de execução. */
  noDeadlineCommitment: boolean;
  /** Não garantir resultado ("você vai conseguir X"). */
  noResultPromise: boolean;
  /** Não vazar dado de outro cliente (multi-tenant isolation). */
  noCrossClientDataLeak: boolean;
  /** Emojis bloqueados. Default: 👋 ✅ 🎉. */
  forbiddenEmojis: string[];
  /** Idioma de resposta. Default: pt-BR. */
  language: 'pt-BR' | 'en-US';
  /** Regras adicionais por org (empilham sob as defaults). */
  customRules?: string[];
}

/**
 * Contexto enriquecido da conversa atual.
 *
 * **Quem produz**: Agent 8 (Context Enricher) lê DB + memória + catálogo
 * e devolve este objeto pronto. O composer só consome.
 *
 * **Quem consome**: PromptComposerService.compose() → buildContextLayer()
 *
 * Campos opcionais ficam fora do prompt quando ausentes (não emitir
 * "Cliente: undefined" ou "Memória: null").
 */
export interface EnrichedContext {
  contact: {
    name?: string;
    email?: string;
    phone?: string;
    /** Tags do CRM. Útil pra segmentar tom (lead-frio vs cliente-vip). */
    tags?: string[];
  };
  channel: {
    kind: 'WHATSAPP' | 'INSTAGRAM' | 'WEB';
    /** Nome legível do canal (ex: "WhatsApp Vendas"). */
    name: string;
  };
  time: {
    /** ISO 8601 do "agora" no momento do compose. */
    nowIso: string;
    /** IANA timezone (ex: "America/Sao_Paulo"). */
    timezone: string;
    /** Já fora/dentro do expediente comercial da org. */
    businessHours: boolean;
  };
  /** Memória persistente do contato com o agent. */
  memory?: {
    /** Resumo livre, 1-3 parágrafos. */
    summary?: string;
    /** Fatos curtos extraídos ("comprou Maestria em mar/26", "prefere áudio"). */
    facts?: string[];
  };
  /** Catálogo compactado da org (slug + tagline). Pitch detalhado vem via skill. */
  catalog?: {
    products: {
      slug: string;
      name: string;
      tagline: string;
      category: string;
    }[];
  };
  /**
   * Últimas N mensagens da conversa (default 30).
   * Composer NÃO injeta isso na string `system` — vai como mensagens
   * separadas pro LLM. Mantemos aqui pro composer ter visão completa
   * (ex: detectar perguntas em aberto na futura layer de behavior).
   */
  recentMessages: { role: 'user' | 'assistant' | 'tool'; content: string }[];
}

/**
 * Input completo do composer.
 *
 * `agent` e `skills` ficam como `any` por enquanto pra evitar acoplar este
 * módulo ao Prisma Client antes da Fase 2. Quando a integração formal rolar,
 * trocar por `AiAgent` e `AiSkill` do `@prisma/client`.
 */
export interface ComposeInput {
  /** Linha do AiAgent (Prisma). */
  agent: any;
  /** Skills do agent (já filtradas, ativas). */
  skills: any[];
  /** Tools built-in disponíveis (ex: ["replyToConversation", "tagConversation"]). */
  builtinTools: string[];
  /** Contexto enriquecido — vem do Agent 8. */
  enrichedContext: EnrichedContext;
  /** Override parcial das regras de segurança (org-level). */
  securityRules?: Partial<SecurityRules>;
}
