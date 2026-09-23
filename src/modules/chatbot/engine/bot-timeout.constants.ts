/**
 * Timeout da triagem: se o cliente não responde o menu, a conversa não pode
 * ficar presa em `status=BOT` (sem dono, fora da fila). Passado esse tempo o
 * worker transfere pro humano como se ele tivesse pedido atendimento.
 *
 * Mora num arquivo próprio porque tanto o chatbot (que agenda) quanto o
 * messaging (que cancela, quando o humano assume antes) precisam do jobId.
 */
export const BOT_TIMEOUT_JOB = 'bot-timeout';

/** Varredura periódica: pega conversas presas em BOT sem timer armado. */
export const BOT_SWEEP_JOB = 'bot-sweep';
export const BOT_SWEEP_EVERY_MS = 5 * 60_000;

export function botTimeoutJobId(conversationId: string): string {
  return `${BOT_TIMEOUT_JOB}:${conversationId}`;
}

/** Minutos de silêncio até desistir do menu (env CHATBOT_TIMEOUT_MINUTES). */
export function botTimeoutMinutes(): number {
  const raw = Number(process.env.CHATBOT_TIMEOUT_MINUTES);
  return Number.isFinite(raw) && raw > 0 ? raw : 10;
}
