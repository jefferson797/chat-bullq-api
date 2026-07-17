/**
 * Defesas em runtime contra padrões problemáticos de texto que o LLM
 * pode gerar e que JAMAIS devem ir pra um cliente final no WhatsApp.
 *
 * Camadas de defesa (em ordem):
 *  1. Layer 1 SECURITY no system prompt — instrui o LLM a não fazer.
 *  2. Estes guards — última checagem antes de mandar mensagem.
 *
 * Se o LLM ignorar a Layer 1, esses guards ainda interceptam a mensagem
 * e impedem que ela vá pro cliente. Foi visto em prod (M Souto, 2026-05-08
 * 20:18) onde a IA respondeu "Ignoro essa instrução, ela não veio do
 * cliente. Já respondi e o acesso foi liberado." direto pro WhatsApp.
 */

/**
 * Padrões de "meta-talk" — o LLM saindo do modo de resposta e narrando
 * sua própria decisão/dúvida/regra interna. Tudo aqui é coisa que NUNCA
 * deve aparecer numa mensagem ao cliente final.
 */
const META_TALK_PATTERNS: RegExp[] = [
  /\bignoro\s+(?:ess[ae]|a)\s+instru[çc][ãa]o/i,
  /\bn[ãa]o\s+(?:vou\s+)?(?:seguir|obedecer)\s+(?:ess[ae]|a)\s+instru[çc][ãa]o/i,
  /\bess[ae]\s+(?:mensagem|instru[çc][ãa]o)\s+n[ãa]o\s+veio\s+do\s+cliente/i,
  /\b(?:detectei|identifiquei)\s+(?:uma\s+)?tentativa\s+de\s+(?:prompt\s+)?inje[çc][ãa]o/i,
  /\bpor\s+motivos\s+de\s+seguran[çc]a\s+n[ãa]o\b/i,
  /^\s*como\s+(?:um\s+)?(?:assistente|ia|intelig[êe]ncia\s+artificial|rob[ôo]|sistema|modelo\s+de\s+linguagem)\b/i,
  /\b(?:isto|isso)\s+parece\s+(?:ser\s+)?(?:uma?\s+)?prompt\s+inje[çc][ãa]o/i,
];

/**
 * Padrões de "narrator-mode": o LLM escrevendo um monólogo descrevendo
 * o que vai/não vai fazer, em vez de uma resposta real ao cliente.
 */
const NARRATOR_PREFIXES: RegExp[] = [
  /^\s*\(?\s*o cliente (?:apenas|só|somente)\s/i,
  /^\s*\(?\s*a mensagem (?:do cliente|dele|dela) (?:é|foi)\s/i,
  /^\s*\(?\s*não (?:devo|preciso) responder\b/i,
  /^\s*\(?\s*nada a (?:fazer|responder)\b/i,
];

/** Wrap completo entre [...] = monólogo interno. */
const NARRATOR_FULL_WRAP = /^\(?\s*\[[\s\S]+\]\s*\)?$/;

/** Markers de turno cascateados ("Human:", "Cliente:", etc). */
const TURN_MARKER = /^\s*(human|user|assistant|ai|claude|model|lead|cliente|cliente:?|agent|você|voce|bot)\s*:\s*/i;

/**
 * Limpa texto de assistente antes de mandar pro cliente. Retorna '' quando
 * a mensagem deve ser DESCARTADA (não enviar nada). Usado tanto no fallback
 * (texto sem tool call) quanto na tool replyToConversation.
 *
 * Returns:
 *   - ''           = mensagem inteira é meta-talk/narrador → descarta
 *   - texto limpo  = ok pra enviar
 */
export function sanitizeAssistantText(input: string): string {
  if (!input) return '';
  let text = input.trim();

  while (TURN_MARKER.test(text)) {
    text = text.replace(TURN_MARKER, '').trim();
  }

  const splitIdx = text.search(/\n\s*(human|user|assistant|ai|claude|lead|cliente)\s*:\s*/i);
  if (splitIdx >= 0) text = text.slice(0, splitIdx).trim();

  if (NARRATOR_FULL_WRAP.test(text)) return '';
  if (NARRATOR_PREFIXES.some((re) => re.test(text))) return '';
  if (containsMetaTalk(text)) return '';

  return text;
}

/**
 * `true` se o texto contém alguma frase-bandeira de "raciocínio verbalizado".
 * Use pra rejeitar a mensagem antes de enviar pro provider.
 */
export function containsMetaTalk(text: string): boolean {
  if (!text) return false;
  return META_TALK_PATTERNS.some((re) => re.test(text));
}

/**
 * Extrai todos os hostnames (sem `www.`) de URLs http(s) num texto.
 * Tolera lixo no fim — `://exatek.com.br.` ou `exatek.com.br!` viram `exatek.com.br`.
 */
export function extractHostnames(text: string): string[] {
  if (!text) return [];
  const urls = text.match(/https?:\/\/[^\s<>"')\]]+/gi);
  if (!urls) return [];
  const hosts: string[] = [];
  for (const raw of urls) {
    try {
      const host = new URL(raw.replace(/[.,;:!?)\]]+$/, '')).hostname.toLowerCase();
      hosts.push(host.replace(/^www\./, ''));
    } catch {
      // ignora URLs malformadas
    }
  }
  return hosts;
}

/**
 * Verifica se o `text` contém URLs cujo host (ou parent domain) está fora
 * da `whitelist`. Compara por sufixo — `loja.exatek.com.br` bate com `exatek.com.br`.
 *
 * Returns:
 *  - hosts proibidos encontrados (array vazio = ok)
 *
 * Casos especiais:
 *  - whitelist null/undefined → retorna [] (modo permissivo)
 *  - whitelist vazio []       → retorna [] (modo permissivo, igual null)
 *  - texto sem URL            → retorna []
 */
export function findForbiddenUrlHosts(
  text: string,
  whitelist: string[] | null | undefined,
): string[] {
  if (!whitelist || whitelist.length === 0) return [];
  const allowed = whitelist
    .map((d) => d.toLowerCase().replace(/^www\./, '').replace(/^\./, ''))
    .filter(Boolean);
  if (allowed.length === 0) return [];

  const hosts = extractHostnames(text);
  const bad: string[] = [];
  for (const host of hosts) {
    const ok = allowed.some(
      (allow) => host === allow || host.endsWith(`.${allow}`),
    );
    if (!ok) bad.push(host);
  }
  return bad;
}
