import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ConversationStatus } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';

@Injectable()
export class SlaService {
  private readonly logger = new Logger(SlaService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('sla-timers') private readonly slaQueue: Queue,
  ) {}

  /**
   * Arma o timer de PRIMEIRA RESPOSTA da conversa, se o setor dela tiver
   * `slaFirstResponse` configurado. No-op quando: conversa já respondida
   * (`firstResponseAt`), encerrada, ou sem SLA no setor.
   *
   * Idempotente: o `jobId` fixo faz o BullMQ ignorar re-armadas enquanto o
   * timer está pendente — o relógio começa na 1ª mensagem sem resposta e
   * não reinicia a cada nova mensagem do cliente.
   */
  async scheduleFirstResponseTimer(conversationId: string, organizationId: string): Promise<void> {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { department: true },
    });
    if (!conversation) return;
    if (conversation.firstResponseAt || conversation.status === ConversationStatus.CLOSED) return;

    const slaMinutes = conversation.department?.slaFirstResponse;
    if (!slaMinutes || slaMinutes <= 0) return;

    await this.slaQueue.add(
      'sla-check',
      { conversationId, type: 'first-response', organizationId },
      { delay: slaMinutes * 60 * 1000, jobId: `sla-fr-${conversationId}` },
    );

    this.logger.log(`SLA first-response timer set: ${slaMinutes}min for conv=${conversationId}`);
  }

  /**
   * Arma o timer de RESOLUÇÃO da conversa, se o setor tiver `slaResolution`.
   * No-op quando encerrada ou sem SLA. Idempotente pelo `jobId`.
   */
  async scheduleResolutionTimer(conversationId: string, organizationId: string): Promise<void> {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { department: true },
    });
    if (!conversation) return;
    if (conversation.status === ConversationStatus.CLOSED) return;

    const slaMinutes = conversation.department?.slaResolution;
    if (!slaMinutes || slaMinutes <= 0) return;

    await this.slaQueue.add(
      'sla-check',
      { conversationId, type: 'resolution', organizationId },
      { delay: slaMinutes * 60 * 1000, jobId: `sla-res-${conversationId}` },
    );

    this.logger.log(`SLA resolution timer set: ${slaMinutes}min for conv=${conversationId}`);
  }

  /**
   * Cancela só o timer de primeira resposta — usado quando o vendedor
   * responde (a resolução continua correndo até o encerramento).
   */
  async cancelFirstResponseTimer(conversationId: string): Promise<void> {
    try {
      const frJob = await this.slaQueue.getJob(`sla-fr-${conversationId}`);
      if (frJob) await frJob.remove();
    } catch {
      // Job may not exist
    }
  }

  /** Cancela ambos os timers — usado quando a conversa é encerrada. */
  async cancelTimers(conversationId: string): Promise<void> {
    try {
      const frJob = await this.slaQueue.getJob(`sla-fr-${conversationId}`);
      if (frJob) await frJob.remove();
      const resJob = await this.slaQueue.getJob(`sla-res-${conversationId}`);
      if (resJob) await resJob.remove();
    } catch {
      // Job may not exist
    }
  }
}
