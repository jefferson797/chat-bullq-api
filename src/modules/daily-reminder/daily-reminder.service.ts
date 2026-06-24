import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma.service';

/**
 * Lembrete diário pra equipe de vendas, enviado por WhatsApp (Zappfy)
 * de segunda a sexta no horário configurado.
 *
 * Texto/destinatário/horário ficam abaixo (fixos). Pra mudar o texto é só
 * editar TEXT e redeployar. Desliga com REMINDER_ENABLED=false.
 *
 * Tick de 5min cobre a janela do horário-alvo (8:50–8:59). Anti-duplicação
 * por dia via flag em memória.
 */
@Injectable()
export class DailyReminderService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DailyReminderService.name);
  private static readonly ZAPPFY_BASE = 'https://api.zappfy.io';
  private static readonly TICK_MS = 5 * 60 * 1000; // 5min

  // ─── Configuração do lembrete ────────────────────────────────────────
  private static readonly NUMBER = '5511964522654';
  private static readonly TZ = 'America/Sao_Paulo';
  private static readonly HOUR = 8;
  private static readonly MINUTE = 50;
  private static readonly WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  private static readonly TEXT =
    `🚀 Bom dia, time! Bora pro jogo.\n` +
    `Antes de abrir as conversas, três lembretes rápidos pra hoje render:\n\n` +
    `1. *Meta do dia: R$1.000 no mínimo.* Esse é o piso, não o teto. Cada conversa bem conduzida é um passo pra lá.\n\n` +
    `2. *Salva TODO contato na hora.* Nome + sobrenome + empresa. Contato salvo certo hoje é venda recorrente amanhã. Lead sem nome é lead que some.\n\n` +
    `3. *Velocidade fecha venda.* Resposta rápida + tom amigável + facilitar a vida do cliente = conversão. Quem responde primeiro e melhor, leva o pedido.\n\n` +
    `📌 Sempre começa com o /saudacao e usa os atalhos pra agilizar (preço, prazo, arquivo). Eles existem pra você ganhar tempo e padronizar — usa todos.\n\n` +
    `⏰ No fim do dia: raspagem dos que não fecharam. Volta em quem ficou no "vou pensar" com um empurrãozinho de urgência ("hoje ainda consigo encaixar na produção", "essa condição é até sexta"). Senso de urgência vende.\n\n` +
    `💡 Lembra: por trás de cada pedido tem uma operação rodando, máquina ligada, gente trabalhando — tudo custa pra acontecer. Bater a meta não é só número, é o que mantém tudo girando. Seu papel aqui é peça-chave.\n\n` +
    `Agora é com você. Atende rápido, atende bem, e fecha. Vamos fazer o dia valer! 💪`;

  private lastSentDay = '';
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    setTimeout(() => void this.tick(), 60_000);
    this.timer = setInterval(() => void this.tick(), DailyReminderService.TICK_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if ((this.config.get<string>('REMINDER_ENABLED') ?? 'true') === 'false') return;
    try {
      const { weekday, minuteOfDay, day } = this.localNow();
      if (!DailyReminderService.WEEKDAYS.includes(weekday)) return;
      const target = DailyReminderService.HOUR * 60 + DailyReminderService.MINUTE;
      if (minuteOfDay < target || minuteOfDay >= target + 10) return;
      if (this.lastSentDay === day) return;

      if (await this.sendWhatsapp(DailyReminderService.NUMBER, DailyReminderService.TEXT)) {
        this.lastSentDay = day;
        this.logger.log(`daily reminder sent (${day})`);
      }
    } catch (err: any) {
      this.logger.warn(`daily reminder tick failed: ${err?.message ?? err}`);
    }
  }

  private localNow(): { weekday: string; minuteOfDay: number; day: string } {
    const now = new Date();
    try {
      const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: DailyReminderService.TZ,
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        day: '2-digit',
        month: '2-digit',
      });
      const p = fmt.formatToParts(now);
      const get = (t: string) => p.find((x) => x.type === t)?.value ?? '';
      const hour = Number(get('hour')) % 24;
      const minute = Number(get('minute'));
      return {
        weekday: get('weekday'),
        minuteOfDay: hour * 60 + minute,
        day: `${get('day')}/${get('month')}`,
      };
    } catch {
      return {
        weekday: '',
        minuteOfDay: now.getUTCHours() * 60 + now.getUTCMinutes(),
        day: `${now.getUTCDate()}/${now.getUTCMonth() + 1}`,
      };
    }
  }

  /** Envio público pra teste manual, se precisar. */
  async sendNow(): Promise<boolean> {
    return this.sendWhatsapp(DailyReminderService.NUMBER, DailyReminderService.TEXT);
  }

  private async sendWhatsapp(number: string, text: string): Promise<boolean> {
    try {
      const channel = await this.prisma.channel.findFirst({
        where: { type: 'WHATSAPP_ZAPPFY', deletedAt: null, isActive: true },
        select: { config: true },
      });
      const token = (channel?.config as Record<string, any>)?.token;
      if (!token) {
        this.logger.warn('daily reminder: nenhum canal Zappfy ativo com token');
        return false;
      }
      const resp = await fetch(`${DailyReminderService.ZAPPFY_BASE}/send/text`, {
        method: 'POST',
        headers: { token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ number, text, delay: 0 }),
      });
      if (!resp.ok) {
        this.logger.warn(`daily reminder send failed: HTTP ${resp.status}`);
        return false;
      }
      return true;
    } catch (err: any) {
      this.logger.warn(`daily reminder send error: ${err?.message ?? err}`);
      return false;
    }
  }
}
