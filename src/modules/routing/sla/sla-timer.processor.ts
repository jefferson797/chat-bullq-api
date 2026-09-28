import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { ConversationStatus, NotificationType } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { contactDisplayTitle } from '../../../common/utils/contact-display.util';
import { AutoRepliesService } from '../../auto-replies/auto-replies.service';
import { dentroDoExpediente, msAteAbrir } from './business-hours.util';

@Processor('sla-timers', { concurrency: 2 })
export class SlaTimerProcessor extends WorkerHost {
  private readonly logger = new Logger(SlaTimerProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly autoReplies: AutoRepliesService,
    @InjectQueue('sla-timers') private readonly slaQueue: Queue,
  ) {
    super();
  }

  async process(job: Job): Promise<any> {
    const { conversationId, type, organizationId } = job.data as {
      conversationId: string;
      type: 'first-response' | 'resolution';
      organizationId: string;
    };

    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { contact: { select: { name: true, firstName: true, lastName: true, company: true, phone: true } }, assignedTo: { select: { id: true, name: true } } },
    });

    if (!conversation) return { skipped: true, reason: 'conversation_not_found' };

    if (type === 'first-response') {
      if (conversation.firstResponseAt || conversation.status === ConversationStatus.CLOSED) {
        return { skipped: true, reason: 'already_responded_or_closed' };
      }

      // Alerta fora do expediente não é alerta: ninguém pode agir, e o sino
      // amanhece cheio de coisa que a pessoa não deixou de fazer. Reagenda pra
      // abertura (o relógio do SLA só corre quando tem gente pra atender).
      const espera = await this.esperaAteExpediente(organizationId);
      if (espera !== null) {
        await this.slaQueue.add(
          'sla-check',
          { conversationId, type, organizationId },
          { delay: espera, jobId: `sla-fr-${conversationId}` },
        );
        this.logger.log(
          `SLA fora do expediente: conv=${conversationId} reagendado para daqui a ${Math.round(espera / 60000)} min`,
        );
        return { rescheduled: true, inMinutes: Math.round(espera / 60000) };
      }

      const contactName = contactDisplayTitle(conversation.contact);

      await this.notifications.notifyOrgAgents({
        organizationId,
        type: NotificationType.SLA_BREACH,
        title: 'SLA de primeira resposta violado',
        body: `A conversa com ${contactName} ultrapassou o tempo de SLA sem resposta.`,
        data: { conversationId, slaType: 'first-response' },
      });

      this.logger.warn(`SLA first-response BREACH: conversation=${conversationId}`);
      return { breach: true, type: 'first-response' };
    }

    if (type === 'resolution') {
      if (conversation.status === ConversationStatus.CLOSED) {
        return { skipped: true, reason: 'already_closed' };
      }

      const contactName = contactDisplayTitle(conversation.contact);

      await this.notifications.notifyOrgAgents({
        organizationId,
        excludeUserId: conversation.assignedTo?.id,
        type: NotificationType.SLA_WARNING,
        title: 'SLA de resolução em risco',
        body: `A conversa com ${contactName} está se aproximando do limite de SLA.`,
        data: { conversationId, slaType: 'resolution' },
      });

      if (conversation.assignedTo) {
        await this.notifications.notify({
          recipientId: conversation.assignedTo.id,
          organizationId,
          type: NotificationType.SLA_BREACH,
          title: 'SLA de resolução violado',
          body: `Sua conversa com ${contactName} ultrapassou o SLA de resolução.`,
          data: { conversationId, slaType: 'resolution' },
        });
      }

      this.logger.warn(`SLA resolution BREACH: conversation=${conversationId}`);
      return { breach: true, type: 'resolution' };
    }

    return { skipped: true, reason: 'unknown_type' };
  }

  /**
   * Milissegundos até a empresa abrir, ou `null` quando já está aberta (ou
   * quando não há horário configurado — aí é melhor avisar na hora do que
   * nunca avisar). Usa o mesmo horário comercial das respostas automáticas,
   * pra não existirem dois "horários da empresa" divergindo em silêncio.
   */
  private async esperaAteExpediente(organizationId: string): Promise<number | null> {
    try {
      const config = await this.autoReplies.getConfig(organizationId);
      if (!config?.businessHours) return null;
      if (dentroDoExpediente(config)) return null;
      const espera = msAteAbrir(config);
      // margem de 1 min: o job não pode acordar no instante exato da abertura
      return espera === null ? null : espera + 60_000;
    } catch (err: any) {
      this.logger.warn(`não consegui ler o horário comercial: ${err?.message ?? err}`);
      return null;
    }
  }
}
