import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { ConversationStatus } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { ChatbotEngineService } from './chatbot-engine.service';
import { AutoAssignService } from '../../messaging/pipeline/auto-assign.service';

/** Etiqueta aplicada quando a triagem encerra sem transferir (ex.: abaixo do mínimo). */
export const TRIAGE_CLOSED_TAG = 'triagem-abaixo-minimo';

interface ChatbotJobData {
  conversationId: string;
  channelId: string;
  contactExternalId: string;
  organizationId: string;
  messageText: string;
}

@Processor('chatbot-processor', { concurrency: 5 })
export class ChatbotProcessor extends WorkerHost {
  private readonly logger = new Logger(ChatbotProcessor.name);

  constructor(
    private readonly engine: ChatbotEngineService,
    private readonly prisma: PrismaService,
    private readonly autoAssign: AutoAssignService,
    @InjectQueue('outbound-messages') private readonly outboundQueue: Queue,
  ) {
    super();
  }

  async process(job: Job<ChatbotJobData>): Promise<any> {
    const { conversationId, channelId, contactExternalId, organizationId, messageText } = job.data;

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

    if (result.sessionEnded && !result.transferToHuman) {
      // Triagem encerrou sem humano (ex.: pedido abaixo do mínimo): fecha a
      // conversa e etiqueta, pra não ocupar a fila. Se o cliente responder,
      // reabre e vai pro vendedor (botDone impede voltar ao menu).
      await this.closeAfterTriage(conversationId, organizationId);
      this.logger.log(`Bot session ended for conversation ${conversationId} (fechada + etiqueta)`);
    }

    return { messagesCount: result.messages.length, transferred: result.transferToHuman };
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
