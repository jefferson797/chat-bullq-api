import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  MessageContentType,
  MessageDirection,
  MessageStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import {
  AutoReplyConfig,
  AutoReplyScenario,
  DEFAULT_AUTO_REPLY_CONFIG,
  Weekday,
  mergeAutoReplyConfig,
} from './auto-reply.types';

const WD_KEYS: Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

@Injectable()
export class AutoRepliesService {
  private readonly logger = new Logger(AutoRepliesService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('outbound-messages') private readonly outboundQueue: Queue,
  ) {}

  // ─── Config (persistida em organization.settings.autoReply) ──────────

  async getConfig(organizationId: string): Promise<AutoReplyConfig> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { settings: true },
    });
    const settings = (org?.settings as Record<string, any>) || {};
    return mergeAutoReplyConfig(settings.autoReply);
  }

  async updateConfig(
    organizationId: string,
    incoming: unknown,
  ): Promise<AutoReplyConfig> {
    const merged = mergeAutoReplyConfig(incoming);
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { settings: true },
    });
    const settings = (org?.settings as Record<string, any>) || {};
    await this.prisma.organization.update({
      where: { id: organizationId },
      data: {
        settings: {
          ...settings,
          autoReply: merged,
        } as unknown as Prisma.InputJsonValue,
      },
    });
    return merged;
  }

  // ─── Disparo no recebimento de mensagem ──────────────────────────────

  /**
   * Avalia e (se for o caso) envia UMA mensagem automática para a conversa.
   * Chamado pelo pipeline de inbound, fire-and-forget. Nunca lança.
   */
  async maybeSend(
    conversationId: string,
    organizationId: string,
  ): Promise<void> {
    try {
      const config = await this.getConfig(organizationId);
      if (!config.enabled) return;

      const conversation = await this.prisma.conversation.findFirst({
        where: { id: conversationId, organizationId },
        include: {
          contact: { include: { channels: true } },
          channel: true,
        },
      });
      if (!conversation || conversation.isGroup) return;

      // Não conflitar com a IA: se a IA está ativa pro canal, ela responde.
      const org = await this.prisma.organization.findUnique({
        where: { id: organizationId },
        select: { aiEnabled: true },
      });
      const chAi = conversation.channel.aiEnabled;
      const aiOn = chAi === true || (chAi !== false && org?.aiEnabled === true);
      if (aiOn) return;

      // É a primeira mensagem recebida da conversa? (saudação)
      const inboundCount = await this.prisma.message.count({
        where: {
          conversationId,
          direction: MessageDirection.INBOUND,
        },
      });
      const isFirstInbound = inboundCount <= 1;

      const scenario = this.resolveScenario(config, isFirstInbound);
      if (!scenario) return;

      // Anti-spam: não repete mensagem automática antes de antiSpamHours.
      const meta = (conversation.metadata as Record<string, any>) || {};
      const last = meta.autoReply?.lastSentAt
        ? Date.parse(meta.autoReply.lastSentAt)
        : 0;
      const windowMs = Math.max(0, config.antiSpamHours) * 3600 * 1000;
      if (scenario !== 'greeting' && last && Date.now() - last < windowMs) {
        return;
      }

      const text = this.textFor(config, scenario);
      if (!text) return;

      const contactChannel = conversation.contact.channels.find(
        (cc) => cc.channelId === conversation.channelId,
      );
      if (!contactChannel) return;

      await this.send(
        conversation.id,
        conversation.channelId,
        contactChannel.externalId,
        text,
        scenario,
      );

      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          metadata: {
            ...meta,
            autoReply: {
              lastSentAt: new Date().toISOString(),
              lastType: scenario,
            },
          },
        },
      });
      this.logger.log(
        `auto_reply_sent conv=${conversation.id} scenario=${scenario}`,
      );
    } catch (err: any) {
      this.logger.warn(`auto_reply failed conv=${conversationId}: ${err?.message ?? err}`);
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────

  /** Resolve qual cenário (no máximo um) se aplica agora. Prioridade: fora > almoço > saudação. */
  private resolveScenario(
    config: AutoReplyConfig,
    isFirstInbound: boolean,
  ): AutoReplyScenario {
    const { dow, minutes } = this.localNow(config.timezone);
    const windows = config.businessHours[dow] || [];
    const open = windows.some(
      ([s, e]) => minutes >= this.toMin(s) && minutes < this.toMin(e),
    );

    if (!open) {
      return config.offHours.enabled ? 'offHours' : isGreet();
    }
    const inLunch =
      config.lunch.enabled &&
      minutes >= this.toMin(config.lunch.start) &&
      minutes < this.toMin(config.lunch.end);
    if (inLunch) {
      return config.lunchMsg.enabled ? 'lunch' : isGreet();
    }
    return isGreet();

    function isGreet(): AutoReplyScenario {
      return isFirstInbound && config.greeting.enabled ? 'greeting' : null;
    }
  }

  private textFor(config: AutoReplyConfig, s: AutoReplyScenario): string {
    if (s === 'greeting') return config.greeting.text.trim();
    if (s === 'lunch') return config.lunchMsg.text.trim();
    if (s === 'offHours') return config.offHours.text.trim();
    return '';
  }

  /** Hora local (no fuso configurado) → dia da semana + minutos do dia. */
  private localNow(tz: string): { dow: Weekday; minutes: number } {
    const now = new Date();
    let dowIdx = now.getUTCDay();
    let minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    try {
      const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
      const parts = fmt.formatToParts(now);
      const wd = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun';
      const hh = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
      const mm = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
      const map: Record<string, number> = {
        Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
      };
      dowIdx = map[wd] ?? dowIdx;
      // '24:00' edge → normaliza
      minutes = (hh % 24) * 60 + mm;
    } catch {
      /* fuso inválido → cai pro UTC (já calculado acima) */
    }
    return { dow: WD_KEYS[dowIdx], minutes };
  }

  private toMin(hm: string): number {
    const [h, m] = String(hm).split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  }

  private async send(
    conversationId: string,
    channelId: string,
    contactExternalId: string,
    body: string,
    scenario: AutoReplyScenario,
  ): Promise<void> {
    const message = await this.prisma.message.create({
      data: {
        conversationId,
        direction: MessageDirection.OUTBOUND,
        type: MessageContentType.TEXT,
        content: { text: body },
        status: MessageStatus.QUEUED,
        senderId: null,
        metadata: { source: 'auto-reply', autoReplyType: scenario },
      },
    });
    await this.outboundQueue.add(
      'send-outbound',
      {
        messageId: message.id,
        channelId,
        contactExternalId,
        message: { type: 'TEXT', content: { text: body } },
      },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
  }
}

// re-export pra conveniência dos imports do controller
export { DEFAULT_AUTO_REPLY_CONFIG };
