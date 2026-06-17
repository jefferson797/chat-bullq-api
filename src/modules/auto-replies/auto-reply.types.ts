// Configuração de mensagens automáticas (saudação / almoço / fora de expediente).
// Persistida em Organization.settings.autoReply (sem migração de schema).

export type Weekday = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';

/** Janela de horário no formato [["09:00","18:00"], ...] por dia. */
export type DayWindows = [string, string][];

export interface AutoReplyMessage {
  enabled: boolean;
  text: string;
}

export interface AutoReplyConfig {
  /** Liga/desliga todo o atendimento automático. */
  enabled: boolean;
  timezone: string;
  /** Horário de funcionamento por dia da semana (janelas). */
  businessHours: Record<Weekday, DayWindows>;
  /** Intervalo de almoço (uma janela por dia útil). */
  lunch: { enabled: boolean; start: string; end: string };
  /** Não repetir a mesma msg automática pro mesmo cliente antes de N horas. */
  antiSpamHours: number;
  greeting: AutoReplyMessage;
  lunchMsg: AutoReplyMessage;
  offHours: AutoReplyMessage;
}

const WD: DayWindows = [['09:00', '18:00']];

export const DEFAULT_AUTO_REPLY_CONFIG: AutoReplyConfig = {
  enabled: true,
  timezone: 'America/Sao_Paulo',
  businessHours: {
    mon: WD,
    tue: WD,
    wed: WD,
    thu: WD,
    fri: WD,
    sat: [['09:00', '13:00']],
    sun: [],
  },
  lunch: { enabled: true, start: '12:00', end: '13:00' },
  antiSpamHours: 4,
  greeting: {
    enabled: true,
    text: 'Olá! Seja bem-vindo à Exatek 👋 Em que posso ajudar?',
  },
  lunchMsg: {
    enabled: true,
    text: 'Estamos em horário de almoço (12h–13h). Já já retornamos seu contato!',
  },
  offHours: {
    enabled: true,
    text: 'Recebemos sua mensagem fora do horário de atendimento (Seg–Sex 9h–18h). Retornaremos no próximo horário útil.',
  },
};

/** Mescla a config salva (parcial/legada) com os defaults — fail-safe. */
export function mergeAutoReplyConfig(raw: unknown): AutoReplyConfig {
  const d = DEFAULT_AUTO_REPLY_CONFIG;
  const c = (raw && typeof raw === 'object' ? raw : {}) as Partial<AutoReplyConfig>;
  return {
    enabled: typeof c.enabled === 'boolean' ? c.enabled : d.enabled,
    timezone: c.timezone || d.timezone,
    businessHours: { ...d.businessHours, ...(c.businessHours || {}) },
    lunch: { ...d.lunch, ...(c.lunch || {}) },
    antiSpamHours:
      typeof c.antiSpamHours === 'number' ? c.antiSpamHours : d.antiSpamHours,
    greeting: { ...d.greeting, ...(c.greeting || {}) },
    lunchMsg: { ...d.lunchMsg, ...(c.lunchMsg || {}) },
    offHours: { ...d.offHours, ...(c.offHours || {}) },
  };
}

export type AutoReplyScenario = 'greeting' | 'lunch' | 'offHours' | null;
