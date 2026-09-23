import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { ConversationStatus } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { ChatbotEngineService } from './chatbot-engine.service';
import { ChatbotSessionService } from '../session/chatbot-session.service';
import { AutoAssignService } from '../../messaging/pipeline/auto-assign.service';
import {
  BOT_SWEEP_EVERY_MS,
  BOT_SWEEP_JOB,
  BOT_TIMEOUT_JOB,
  botTimeoutJobId,
  botTimeoutMinutes,
} from './bot-timeout.constants';

/** Etiqueta aplicada quando a triagem encerra sem transferir (ex.: abaixo do mínimo). */
export const TRIAGE_CLOSED_TAG = 'triagem-abaixo-minimo';

/** Mensagem enviada quando o cliente abandona o menu e a gente passa pro humano. */
const TIMEOUT_MESSAGE =
  'Sem problema — já estou te passando pra alguém da equipe. 🙂';

interface ChatbotJobData {
  conversationId: string;
  channelId: string;
  contactExternalId: string;
  organizationId: string;
  messageText: string;
}

@Processor('chatbot-processor', { concurrency: 5 })
export class ChatbotProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(ChatbotProcessor.name);

  constructor(
    private readonly engine: ChatbotEngineService,
    private readonly prisma: PrismaService,
    private readonly autoAssign: AutoAssignService,
    private readonly session: ChatbotSessionService,
    @InjectQueue('outbound-messages') private readonly outboundQueue: Queue,
    @InjectQueue('chatbot-processor') private readonly chatbotQueue: Queue,
  ) {
    super();
  }

  /**
   * Rede de segurança: o timer de cada conversa vive no Redis e some se a fila
   * for limpa/migrada. Uma varredura periódica garante que ninguém fique preso
   * no bot — inclusive as conversas que já estavam paradas antes deste código.
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.chatbotQueue.add(
        BOT_SWEEP_JOB,
        { conversationId: '', channelId: '', contactExternalId: '', organizationId: '', messageText: '' },
        { repeat: { every: BOT_SWEEP_EVERY_MS }, removeOnComplete: true, removeOnFail: true },
      );
    } catch (err: any) {
      this.logger.warn(`não consegui registrar a varredura do bot: ${err?.message ?? err}`);
    }
  }

  async process(job: Job<ChatbotJobData>): Promise<any> {
    const { conversationId, channelId, contactExternalId, organizationId, messageText } = job.data;

    if (job.name === BOT_TIMEOUT_JOB) {
      return this.handleTimeout(conversationId, channelId, contactExternalId, organizationId);
    }
    if (job.name === BOT_SWEEP_JOB) {
      return this.sweepStuck();
    }

    const result = await this.engine.processMessage(
      conversationId,
      channelId,
      contactExternalId,
      messageText,
    );

    for (const msg of result.messages) {
      const saved = await this.prisma.message.create({
        data: {
          conversationId,
          direction: 'OUTBOUND',
          type: msg.type as any,
          content: msg.content,
          status: 'QUEUED',
        },
      });

      await this.outboundQueue.add('send-outbound', {
        messageId: saved.id,
        channelId,
        contactExternalId,
        message: { type: msg.type, content: msg.content },
      });
    }

    if (result.transferToHuman) {
      // botDone: a triagem desta conversa acabou — o inbound não manda mais
      // pro menu (senão a próxima mensagem do cliente caía no bot de novo).
      const conv = await this.prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { metadata: true },
      });
      const meta = (conv?.metadata ?? {}) as Record<string, any>;
      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: {
          status: ConversationStatus.PENDING,
          departmentId: result.transferDepartmentId || undefined,
          metadata: { ...meta, botDone: true, botDoneAt: new Date().toISOString() },
        },
      });

      await this.prisma.conversationAuditLog.create({
        data: {
          conversationId,
          action: 'STATUS_CHANGED',
          fromValue: ConversationStatus.BOT,
          toValue: ConversationStatus.PENDING,
          metadata: { trigger: 'chatbot_transfer' },
        },
      });

      this.logger.log(`Bot transferred conversation ${conversationId} to human`);

      // Lead qualificado não pode ficar "sem dono" esperando a próxima mensagem:
      // atribui já (rodízio do setor padrão), igual ao inbound faz com lead novo.
      await this.autoAssign
        .maybeAutoAssign(conversationId, organizationId, channelId)
        .catch((err) => this.logger.warn(`auto-assign após bot falhou conv=${conversationId}: ${err?.message ?? err}`));
    }

    // Timeout: enquanto o bot espera resposta, mantém um job atrasado armado
    // (rearmado a cada mensagem). Se a triagem terminou, desarma.
    if (!result.transferToHuman && !result.sessionEnded) {
      await this.armTimeout(job.data);
    } else {
      await this.disarmTimeout(conversationId);
    }

    if (result.sessionEnded && !result.transferToHuman) {
      // Triagem encerrou sem humano (ex.: pedido abaixo do mínimo): fecha a
      // conversa e etiqueta, pra não ocupar a fila. Se o cliente responder,
      // reabre e vai pro vendedor (botDone impede voltar ao menu).
      await this.closeAfterTriage(conversationId, organizationId);
      this.logger.log(`Bot session ended for conversation ${conversationId} (fechada + etiqueta)`);
    }

    return { messagesCount: result.messages.length, transferred: result.transferToHuman };
  }

  /** (Re)agenda o job atrasado que tira a conversa do bot se o cliente sumir. */
  private async armTimeout(data: ChatbotJobData): Promise<void> {
    const jobId = botTimeoutJobId(data.conversationId);
    try {
      await this.chatbotQueue.remove(jobId); // rearma do zero a cada mensagem
      await this.chatbotQueue.add(BOT_TIMEOUT_JOB, data, {
        jobId,
        delay: botTimeoutMinutes() * 60_000,
        removeOnComplete: true,
        removeOnFail: true,
      });
    } catch (err: any) {
      this.logger.warn(`não consegui armar timeout conv=${data.conversationId}: ${err?.message ?? err}`);
    }
  }

  private async disarmTimeout(conversationId: string): Promise<void> {
    await this.chatbotQueue.remove(botTimeoutJobId(conversationId)).catch(() => undefined);
  }

  /**
   * Cliente abriu conversa, o bot perguntou e ele nunca respondeu. Em vez de
   * deixar a conversa em BOT (órfã, fora da fila), avisa e entrega pro humano
   * — mesmo caminho do TRANSFER normal.
   */
  private async handleTimeout(
    conversationId: string,
    channelId: string,
    contactExternalId: string,
    organizationId: string,
  ): Promise<any> {
    const conv = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { status: true, metadata: true },
    });
    // Já saiu do bot no meio do caminho (respondeu, humano assumiu, fechou).
    if (!conv || conv.status !== ConversationStatus.BOT) {
      return { skipped: true };
    }

    const saved = await this.prisma.message.create({
      data: {
        conversationId,
        direction: 'OUTBOUND',
        type: 'TEXT',
        content: { text: TIMEOUT_MESSAGE },
        status: 'QUEUED',
      },
    });
    await this.outboundQueue.add('send-outbound', {
      messageId: saved.id,
      channelId,
      contactExternalId,
      message: { type: 'TEXT', content: { text: TIMEOUT_MESSAGE } },
    });

    const meta = (conv.metadata ?? {}) as Record<string, any>;
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        status: ConversationStatus.PENDING,
        metadata: {
          ...meta,
          botDone: true,
          botDoneAt: new Date().toISOString(),
          botOutcome: 'timeout',
        },
      },
    });
    await this.prisma.conversationAuditLog.create({
      data: {
        conversationId,
        action: 'STATUS_CHANGED',
        fromValue: ConversationStatus.BOT,
        toValue: ConversationStatus.PENDING,
        metadata: { trigger: 'chatbot_timeout', minutes: botTimeoutMinutes() },
      },
    });
    await this.session.destroy(conversationId).catch(() => undefined);

    await this.autoAssign
      .maybeAutoAssign(conversationId, organizationId, channelId)
      .catch((err) => this.logger.warn(`auto-assign após timeout falhou conv=${conversationId}: ${err?.message ?? err}`));

    this.logger.log(`Bot timeout: conv=${conversationId} entregue ao humano`);
    return { timedOut: true };
  }

  /**
   * Varre conversas paradas em BOT há mais tempo que o timeout e entrega cada
   * uma pro humano. Cobre o que o timer individual não cobre: conversas que
   * travaram antes deste código existir e timers perdidos num flush do Redis.
   */
  private async sweepStuck(): Promise<any> {
    const limite = new Date(Date.now() - botTimeoutMinutes() * 60_000);
    const presas = await this.prisma.conversation.findMany({
      where: {
        status: ConversationStatus.BOT,
        deletedAt: null,
        OR: [{ lastMessageAt: { lt: limite } }, { lastMessageAt: null, createdAt: { lt: limite } }],
      },
      select: {
        id: true,
        channelId: true,
        organizationId: true,
        contact: { select: { channels: { select: { channelId: true, externalId: true } } } },
      },
      take: 50,
      orderBy: { lastMessageAt: 'asc' },
    });
    if (!presas.length) return { swept: 0 };

    let ok = 0;
    for (const c of presas) {
      const externalId = c.contact.channels.find((cc) => cc.channelId === c.channelId)?.externalId;
      if (!externalId) continue; // sem endereço no canal não dá pra avisar o cliente
      try {
        await this.handleTimeout(c.id, c.channelId, externalId, c.organizationId);
        ok++;
      } catch (err: any) {
        this.logger.warn(`varredura falhou conv=${c.id}: ${err?.message ?? err}`);
      }
    }
    this.logger.log(`Varredura do bot: ${ok}/${presas.length} conversas destravadas`);
    return { swept: ok };
  }

  private async closeAfterTriage(conversationId: string, organizationId: string): Promise<void> {
    const conv = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { metadata: true },
    });
    const meta = (conv?.metadata ?? {}) as Record<string, any>;
    let tag = await this.prisma.tag.findFirst({ where: { organizationId, name: TRIAGE_CLOSED_TAG } });
    if (!tag) {
      tag = await this.prisma.tag.create({ data: { organizationId, name: TRIAGE_CLOSED_TAG, color: '#9CA3AF' } });
    }
    await this.prisma.$transaction([
      this.prisma.conversation.update({
        where: { id: conversationId },
        data: {
          status: ConversationStatus.CLOSED,
          closedAt: new Date(),
          metadata: { ...meta, botDone: true, botDoneAt: new Date().toISOString(), botOutcome: 'below_minimum' },
        },
      }),
      this.prisma.conversationTag.upsert({
        where: { conversationId_tagId: { conversationId, tagId: tag.id } },
        create: { conversationId, tagId: tag.id },
        update: {},
      }),
      this.prisma.conversationAuditLog.create({
        data: {
          conversationId,
          action: 'STATUS_CHANGED',
          fromValue: ConversationStatus.BOT,
          toValue: ConversationStatus.CLOSED,
          metadata: { trigger: 'chatbot_end', outcome: 'below_minimum' },
        },
      }),
    ]);
  }
}
