import { Injectable, Logger } from '@nestjs/common';
import { PromptLayer } from '../types';

/**
 * Layer 2 — PERSONALITY (do agent.systemPrompt)
 *
 * Sanitiza o prompt customizado do agent removendo tentativas explícitas
 * de override de regras de sistema (ex: "ignore as ferramentas", "nunca
 * peça confirmação").
 *
 * Importante: a sanitização é defensiva, não substitui a Layer 1 (Security).
 * Mesmo se um padrão proibido escapar, a Layer 1 entra primeiro e prevalece.
 */

/**
 * Padrões que tentam sobrescrever regras imutáveis do sistema.
 * São substituídos por `[INSTRUÇÃO REMOVIDA]` no prompt do agent.
 */
const FORBIDDEN_PATTERNS: RegExp[] = [
  /ignore.*tool/i,
  /ignor.*ferramenta/i,
  /skip.*confirmation/i,
  /pul.*confirma/i,
  /bypass.*security/i,
  /ignor.*segurança/i,
  /never.*ask.*before/i,
  /nunca.*pergunt.*antes/i,
  /execute.*without.*confirm/i,
  /execut.*sem.*confirm/i,
  /access.*other.*user/i,
  /acess.*outro.*usuári/i,
  /reveal.*prompt/i,
  /revel.*prompt/i,
  /mostr.*system.*prompt/i,
  /promete.*prazo/i,
  /promete.*resultado/i,
];

/**
 * Resultado da sanitização — útil pra logar quando algum padrão suspeito
 * foi removido (sinal de prompt mal escrito ou tentativa de jailbreak).
 */
export interface SanitizedPrompt {
  sanitized: string;
  wasSanitized: boolean;
  removedPatterns: string[];
}

export function sanitizeAgentPrompt(prompt: string): SanitizedPrompt {
  let sanitized = prompt;
  const removed: string[] = [];

  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(sanitized)) {
      removed.push(pattern.source);
      sanitized = sanitized.replace(pattern, '[INSTRUÇÃO REMOVIDA]');
    }
  }

  return {
    sanitized,
    wasSanitized: removed.length > 0,
    removedPatterns: removed,
  };
}

@Injectable()
export class PersonalityLayerService {
  private readonly logger = new Logger(PersonalityLayerService.name);

  /**
   * Monta a camada de personalidade.
   *
   * Lê:
   *   - agent.systemPrompt          → identidade/persona/comportamento
   *   - agent.operationalContext    → contexto vivo da operação (opcional)
   *
   * Função pura: sem I/O, sem chamadas externas. Recebe `agent` como `any`
   * pra não acoplar o módulo ao Prisma Client neste momento (ver types.ts).
   */
  build(agent: {
    name?: string;
    systemPrompt?: string | null;
    operationalContext?: string | null;
    [key: string]: unknown;
  }): PromptLayer {
    const sections: string[] = [];

    sections.push('=== SUA PERSONALIDADE ===');

    const rawPrompt = (agent.systemPrompt ?? '').trim();
    if (rawPrompt.length === 0) {
      // Fallback minimal — agent sem prompt é configuração ruim, mas a
      // camada não pode quebrar. Log de warn fica como sinal pra ops.
      this.logger.warn(
        { event: 'personality_layer_empty_prompt', agentName: agent.name },
        'Agent has no systemPrompt — using fallback persona',
      );
      sections.push(
        'Você é um atendente profissional, direto, em português do Brasil. Tom natural de WhatsApp/chat.',
      );
    } else {
      const { sanitized, wasSanitized, removedPatterns } =
        sanitizeAgentPrompt(rawPrompt);
      if (wasSanitized) {
        this.logger.warn(
          {
            event: 'personality_layer_sanitized',
            agentName: agent.name,
            removedPatterns,
          },
          'Agent prompt was sanitized — suspicious override patterns removed',
        );
      }
      sections.push(sanitized);
    }

    const opCtx = (agent.operationalContext ?? '').trim();
    if (opCtx.length > 0) {
      sections.push('');
      sections.push('=== CONTEXTO OPERACIONAL ===');
      sections.push(
        '(Atualizado pela operação — leia ANTES de responder, assume que o cliente vê reflexo direto disto na conversa.)',
      );
      sections.push('');
      sections.push(opCtx);
    }

    const content = sections.join('\n');
    const tokenEstimate = Math.ceil(content.length / 4);

    this.logger.debug(
      {
        event: 'personality_layer_built',
        agentName: agent.name,
        tokenEstimate,
        hasOperationalContext: opCtx.length > 0,
      },
      'Personality layer built',
    );

    return {
      kind: 'personality',
      content,
      tokenEstimate,
    };
  }
}

/**
 * Helper funcional pra uso direto (testes, scripts).
 */
export function buildPersonalityLayer(agent: {
  name?: string;
  systemPrompt?: string | null;
  operationalContext?: string | null;
  [key: string]: unknown;
}): PromptLayer {
  return new PersonalityLayerService().build(agent);
}
