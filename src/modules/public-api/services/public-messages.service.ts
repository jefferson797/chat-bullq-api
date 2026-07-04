import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  ConversationStatus,
  MessageContentType,
  MessageDirection,
  MessageStatus,
} from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { SendPublicMessageDto } from '../dto/send-public-message.dto';

const OPEN_STATES = [
  ConversationStatus.PENDING,
  ConversationStatus.OPEN,
  ConversationStatus.BOT,
  ConversationStatus.WAITING,
] as const;

/**
 * Envio de mensagem via Public API (ERP/sistemas externos, ex.: Exatek).
 *
 * Comportamento pensado pra notificação transacional (pedido despachado etc.):
 * - A mensagem entra como AUTOMAÇÃO (senderId null): não rouba atribuição de
 *   atendente, não desliga a IA e aparece no chat como envio do sistema.
 * - Se o contato tem conversa ABERTA, a mensagem entra nela.
 * - Se não tem, a conversa é criada já FECHADA — não polui a fila de
 *   atendimento; se o cliente responder, o fluxo inbound normal reabre.
 * - Delivery via fila outbound padrão (retry 3x, backoff exponencial).
 */
@Injectable()
export class PublicMessagesService {
  private readonly logger = new Logger(PublicMessagesService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('outbound-messages') private readonly outboundQueue: Queue,
  ) {}

  async sendText(organizationId: string, dto: SendPublicMessageDto) {
    const contact = await this.prisma.contact.findFirst({
      where: { id: dto.contactId, organizationId, deletedAt: null },
      include: { channels: { include: { channel: true } } },
    });
    if (!contact) throw new NotFoundException('Contact not found');

    // Vínculos utilizáveis: canal WhatsApp ativo da mesma org.
    let bindings = contact.channels.filter(
      (cc) =>
        cc.channel &&
        cc.channel.organizationId === organizationId &&
        cc.channel.isActive &&
        !cc.channel.deletedAt &&
        cc.channel.type.startsWith('WHATSAPP'),
    );
    if (dto.channelId) {
      bindings = bindings.filter((cc) => cc.channelId === dto.channelId);
      if (bindings.length === 0) {
        throw new BadRequestException('Contact has no binding for the requested channel');
      }
    }
    if (bindings.length === 0) {
      throw new UnprocessableEntityException(
        'Contact has no active WhatsApp channel binding',
      );
    }
    const bindingChannelIds = bindings.map((cc) => cc.channelId);

    // Conversa aberta existente tem prioridade — a notificação entra nela.
    const openConversation = await this.prisma.conversation.findFirst({
      where: {
        organizationId,
        contactId: contact.id,
        channelId: { in: bindingChannelIds },
        status: { in: Array.from(OPEN_STATES) },
        deletedAt: null,
      },
      orderBy: { updatedAt: 'desc' },
    });

    let conversationId: string;
    let channelId: string;
    let conversationCreated = false;

    if (openConversation) {
      conversationId = openConversation.id;
      channelId = openConversation.channelId;
    } else {
      // Sem conversa aberta: escolhe o canal da conversa mais recente do
      // contato (qualquer status) ou, na falta, o primeiro vínculo.
      const lastConversation = await this.prisma.conversation.findFirst({
        where: {
          organizationId,
          contactId: contact.id,
          channelId: { in: bindingChannelIds },
          deletedAt: null,
        },
        orderBy: { updatedAt: 'desc' },
        select: { channelId: true },
      });
      channelId = lastConversation?.channelId ?? bindings[0].channelId;

      // Nasce FECHADA de propósito: notificação transacional não entra na
      // fila de atendimento. Resposta do cliente reabre pelo fluxo inbound.
      const now = new Date();
      const conversation = await this.prisma.conversation.create({
        data: {
          organizationId,
          channelId,
          contactId: contact.id,
          status: ConversationStatus.CLOSED,
          closedAt: now,
          protocol: this.generateProtocol(),
        },
      });
      await this.prisma.conversationAuditLog.create({
        data: {
          conversationId: conversation.id,
          action: 'CREATED',
          toValue: ConversationStatus.CLOSED,
          metadata: { trigger: 'public_api_notification' },
        },
      });
      conversationId = conversation.id;
      conversationCreated = true;
    }

    const binding = bindings.find((cc) => cc.channelId === channelId) ?? bindings[0];

    const message = await this.prisma.message.create({
      data: {
        conversationId,
        direction: MessageDirection.OUTBOUND,
        type: MessageContentType.TEXT,
        content: { text: dto.text },
        status: MessageStatus.QUEUED,
        // senderId null = envio do sistema; UI mostra como automação.
        senderId: null,
        metadata: { source: 'public-api' },
      },
    });

    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: new Date() },
    });

    await this.outboundQueue.add(
      'send-outbound',
      {
        messageId: message.id,
        channelId,
        contactExternalId: binding.externalId,
        message: { type: 'TEXT', content: { text: dto.text } },
      },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );

    this.logger.log(
      `Public API message queued: msg=${message.id} conv=${conversationId} contact=${contact.id}${conversationCreated ? ' (new closed conversation)' : ''}`,
    );

    return {
      messageId: message.id,
      conversationId,
      channelId,
      status: 'QUEUED' as const,
      conversationCreated,
    };
  }

  private generateProtocol(): string {
    const now = new Date();
    const date = now.toISOString().slice(0, 10).replace(/-/g, '');
    const rand = Math.random().toString(36).substring(2, 8).toUpperCase();
    return `${date}-${rand}`;
  }
}
