import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  MessageContentType,
  MessageDirection,
  MessageStatus,
} from '@prisma/client';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class RatingsService {
  private readonly logger = new Logger(RatingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @InjectQueue('outbound-messages') private readonly outboundQueue: Queue,
  ) {}

  async requestRating(conversationId: string) {
    const conv = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: {
        id: true,
        organizationId: true,
        assignedToId: true,
        channelId: true,
        contactId: true,
        channel: { select: { type: true, isActive: true, deletedAt: true } },
      },
    });
    if (!conv) return null;

    const existing = await this.prisma.conversationRating.findUnique({
      where: { conversationId },
    });
    if (existing) return existing;

    const token = randomBytes(24).toString('hex');
    const rating = await this.prisma.conversationRating.create({
      data: {
        conversationId,
        organizationId: conv.organizationId,
        agentId: conv.assignedToId,
        score: 0,
        token,
      },
    });

    // Dispara o convite de avaliação no WhatsApp. Fire-and-forget: uma
    // falha no envio NÃO pode derrubar o fechamento da conversa.
    this.sendInvite(conv, token).catch((err) =>
      this.logger.warn(
        `CSAT invite failed for ${conversationId}: ${err?.message ?? err}`,
      ),
    );

    return rating;
  }

  /**
   * Manda o link de avaliação (página pública /avaliar/:token) pro cliente.
   * Só envia quando faz sentido pedir nota: conversa com vendedor responsável
   * e canal WhatsApp ativo com vínculo do contato. Entra como envio do sistema
   * (senderId null) pela fila outbound padrão.
   */
  private async sendInvite(
    conv: {
      id: string;
      channelId: string;
      contactId: string;
      assignedToId: string | null;
      channel: { type: string; isActive: boolean; deletedAt: Date | null } | null;
    },
    token: string,
  ): Promise<void> {
    if (!conv.assignedToId) return; // ninguém atendeu — não pede nota
    if (
      !conv.channel ||
      !conv.channel.type?.startsWith('WHATSAPP') ||
      !conv.channel.isActive ||
      conv.channel.deletedAt
    ) {
      return;
    }

    const binding = await this.prisma.contactChannel.findFirst({
      where: { contactId: conv.contactId, channelId: conv.channelId },
      select: { externalId: true },
    });
    if (!binding) return;

    const webUrl = (
      this.config.get<string>('WEB_URL') ||
      this.config.get<string>('CORS_ORIGIN') ||
      ''
    ).replace(/\/+$/, '');
    if (!webUrl) {
      this.logger.warn('WEB_URL/CORS_ORIGIN não setado — pulando convite CSAT');
      return;
    }
    const link = `${webUrl}/avaliar/${token}`;
    const text =
      `Seu atendimento foi encerrado 🙌\n\n` +
      `Sua opinião vale muito pra gente! De 1 a 5, como você avalia o atendimento que recebeu? ` +
      `É rapidinho:\n${link}`;

    const message = await this.prisma.message.create({
      data: {
        conversationId: conv.id,
        direction: MessageDirection.OUTBOUND,
        type: MessageContentType.TEXT,
        content: { text },
        status: MessageStatus.QUEUED,
        senderId: null, // envio do sistema
        metadata: { source: 'csat' },
      },
    });

    await this.prisma.conversation.update({
      where: { id: conv.id },
      data: { lastMessageAt: new Date() },
    });

    await this.outboundQueue.add(
      'send-outbound',
      {
        messageId: message.id,
        channelId: conv.channelId,
        contactExternalId: binding.externalId,
        message: { type: 'TEXT', content: { text } },
      },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );

    this.logger.log(`CSAT invite queued: msg=${message.id} conv=${conv.id}`);
  }

  async submitByToken(token: string, score: number, comment?: string) {
    if (!Number.isInteger(score) || score < 1 || score > 5) {
      throw new BadRequestException('Score must be an integer between 1 and 5');
    }
    const rating = await this.prisma.conversationRating.findUnique({ where: { token } });
    if (!rating) throw new NotFoundException('Rating request not found');
    if (rating.respondedAt) throw new BadRequestException('Rating already submitted');

    return this.prisma.conversationRating.update({
      where: { token },
      data: { score, comment, respondedAt: new Date() },
      select: { id: true, score: true, respondedAt: true },
    });
  }

  async listForOrg(organizationId: string, limit = 50) {
    return this.prisma.conversationRating.findMany({
      where: { organizationId, respondedAt: { not: null } },
      orderBy: { respondedAt: 'desc' },
      take: limit,
      include: {
        conversation: {
          select: {
            id: true,
            contact: { select: { id: true, name: true } },
            assignedTo: { select: { id: true, name: true } },
          },
        },
      },
    });
  }
}
