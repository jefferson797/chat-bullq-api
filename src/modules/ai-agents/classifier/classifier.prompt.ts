import { ClassifierMessage, RoutableAgent } from './intent.types';

/**
 * System prompt do classifier — DATA-DRIVEN: a lista de destinos vem dos
 * workers ativos da org (banco), nunca de nomes chumbados no código.
 *
 * Bem enxuto de propósito — Haiku é rápido e barato, mas precisa de
 * instrução clara pra não inventar intent novo. A lista de agentes é
 * estável entre mensagens da mesma org, então o bloco continua cacheável.
 */
export function buildClassifierSystemPrompt(agents: RoutableAgent[]): string {
  const agentLines = agents
    .map(
      (a) =>
        `- id: "${a.id}" | ${a.name}${a.description ? ` — ${a.description}` : ''}`,
    )
    .join('\n');

  return `Você é um classificador de intenções de mensagens de WhatsApp/Instagram de clientes de uma empresa.

Especialistas disponíveis para atender (roteie APENAS para ids desta lista):
${agentLines || '(nenhum especialista cadastrado — nunca use ROUTE_TO_AGENT)'}

Classifique a mensagem em UM destes intents (use exatamente o código):
- ROUTE_TO_AGENT: o pedido casa claramente com a especialidade de UM dos especialistas listados
- SMALL_TALK: oi, bom dia, agradecimento, conversa fiada sem pedido claro
- AMBIGUOUS: não dá pra decidir — pedido vago, ou casa com dois ou mais especialistas
- SPAM_OR_NOISE: spam, áudio sem transcrição, link suspeito, mensagem sem sentido
- ESCALATE_HUMAN: cliente irritado, ameaça, reclamação grave, processo, mídia

Regras de confidence:
- 0.95+ : sinal muito claro (palavra-chave inequívoca, contexto óbvio)
- 0.85-0.94: sinal forte mas com alguma ambiguidade
- 0.70-0.84: tem indício mas não dá pra ter certeza
- <0.70: melhor marcar AMBIGUOUS

Responda APENAS com JSON válido, sem markdown, sem explicação extra:
{"intent":"...","confidence":0.0,"reasoning":"frase curta","suggestedAgentId":"id da lista"|null}

Campo suggestedAgentId:
- Obrigatório quando intent=ROUTE_TO_AGENT: use o id EXATO da lista acima.
- null pros demais intents. NUNCA invente um id.`;
}

/**
 * Monta o user prompt: histórico recente (até 3 últimas msgs) + mensagem atual.
 * Sem histórico, só passa a mensagem atual.
 */
export function buildClassifierUserPrompt(
  message: string,
  recentMessages?: ClassifierMessage[],
): string {
  const history =
    recentMessages && recentMessages.length > 0
      ? `Histórico recente:\n${recentMessages
          .slice(-3)
          .map((m) => `${m.role}: ${m.content}`)
          .join('\n')}\n\n`
      : '';
  return `${history}Mensagem atual do cliente:\n"${message}"\n\nClassifique e retorne só o JSON:`;
}
