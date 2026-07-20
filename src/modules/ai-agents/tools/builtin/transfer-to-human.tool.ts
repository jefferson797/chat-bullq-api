import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  MessageContentType,
  MessageDirection,
  MessageStatus,
  NotificationType,
} from '@prisma/client';
import { PrismaService } from '../../../../database/prisma.service';
import { RealtimeGateway } from '../../../realtime/realtime.gateway';
import { NotificationsService } from '../../../notifications/notifications.service';
import { PendingActionService } from '../../confirmations/pending-action.service';
import { AiTool, ToolContext, ToolResult } from '../tool.types';

// Aviso enviado ao cliente no momento em que a IA pede a transferência —
// pra ele não ficar no silêncio esperando. Tom natural, sem jargão interno.
const CUSTOMER_HANDOFF_NOTICE =
  'Deixa eu te transferir pra um atendente da nossa equipe pra te ajudar melhor com isso 🙂 Só um instante que já já alguém te responde por aqui.';

/**
 * Hands the conversation off to a human. Pauses AI on this conversation
 * (so the agent stops responding), moves status to PENDING (so it shows
 * up in the queue), and clears the active agent.
 *
 * Fase 2: a operação real ficou atrás de aprovação humana. A tool agora
 * cria um `PendingAction` (impact=critical) e devolve `requiresUserAction`
 * pro LLM. Quando aprovada, o executor da fase 2 faz o pause/handoff de
 * verdade. Mantemos a notificação imediata pro operador (via realtime)
 * pra ele revisar a fila de pendências sem demora.
 */
@Injectable()
export class TransferToHumanTool implements AiTool {
  private readonly logger = new Logger(TransferToHumanTool.name);

  readonly name = 'transferToHuman';
  readonly description =
    'Hand the conversation over to a human agent. Use this when: the request is outside your competence, the customer explicitly asks for a person, the situation is sensitive (complaint, refund, anger), or you are uncertain. The conversation will move to the queue and AI will be paused.';
  readonly parameters = {
    type: 'object',
    additionalProperties: false,
    required: ['reason'],
    properties: {
      reason: {
        type: 'string',
        description:
          'Short reason for the handoff, in PT-BR. Visible to the human as an internal note. e.g., "Cliente pediu reembolso, fora do meu escopo".',
        minLength: 3,
        maxLength: 500,
      },
      summary: {
        type: 'string',
        description:
          'Optional short summary of the conversation so far so the human picks up faster.',
        maxLength: 1000,
      },
    },
  };

  constructor(
    private readonly realtime: RealtimeGateway,
    private readonly pendingActions: PendingActionService,
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    @InjectQueue('outbound-messages') private readonly outboundQueue: Queue,
  ) {}

  async execute(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const reason = String(input.reason ?? '').trim() || 'Handoff sem motivo informado';
    const summary = input.summary ? String(input.summary).trim() : null;

    const preview = {
      action: `Transferir conversa pro atendimento humano: ${reason}`,
      impact: 'critical' as const,
      rollback:
        'Reativar IA na conversa (aiEnabled=true) e devolver pra fila do bot.',
      affectedEntity: {
        type: 'conversation' as const,
        id: ctx.conversationId,
        label: `conversation:${ctx.conversationId}`,
      },
    };

    const action = await this.pendingActions.create({
      agentRunId: ctx.runId,
      conversationId: ctx.conversationId,
      agentId: ctx.agentId,
      toolName: this.name,
      args: { reason, summary },
      preview,
    });

    // PAUSA A IA IMEDIATAMENTE. Cliente que pediu humano não pode continuar
    // sendo respondido pela IA enquanto a aprovação está na fila — era
    // exatamente o "pedi atendente e o robô continuou falando" que mina a
    // confiança. A ATRIBUIÇÃO da conversa continua atrás da aprovação
    // (quem aprova assume); aqui só silenciamos o agente. Se o operador
    // rejeitar a transferência, ele reativa a IA pelo toggle da conversa.
    await this.prisma.conversation.update({
      where: { id: ctx.conversationId },
      data: {
        aiEnabled: false,
        aiDisabledBy: ctx.agentId,
        aiDisabledAt: new Date(),
        activeAgentId: null,
      },
    });

    // Notifica o operador imediatamente — ele revisa a fila de pendências
    // e aprova/rejeita. O handoff/atribuição acontece após aprovação,
    // pelo executor da fase 2.
    this.realtime.emitToConversation(
      ctx.conversationId,
      'conversation:pending-action',
      {
        conversationId: ctx.conversationId,
        pendingActionId: action.id,
        toolName: this.name,
        impact: preview.impact,
        reason,
      },
    );

    // Notificação PERSISTENTE pro time (sino/central) — pra alguém ver que
    // há uma transferência aguardando aprovação, mesmo sem estar com a
    // conversa aberta. Fire-and-forget: falha aqui não derruba a transferência.
    this.notifications
      .notifyOrgAgents({
        organizationId: ctx.organizationId,
        type: NotificationType.CONVERSATION_TRANSFERRED,
        title: '🤖 IA pediu transferência pra atendente',
        body: reason.slice(0, 240),
        data: {
          conversationId: ctx.conversationId,
          pendingActionId: action.id,
          reason,
          summary,
        },
      })
      .catch((err) =>
        this.logger.warn(
          `notifyOrgAgents falhou (handoff conv ${ctx.conversationId}): ${err?.message ?? err}`,
        ),
      );

    // Avisa o CLIENTE que vai ser transferido — pra ele não ficar no vácuo
    // enquanto o atendente assume. Enviado pelo sistema (fila outbound padrão).
    this.sendCustomerNotice(ctx).catch((err) =>
      this.logger.warn(
        `aviso de transferência ao cliente falhou (conv ${ctx.conversationId}): ${err?.message ?? err}`,
      ),
    );

    this.logger.log(
      `Agent ${ctx.agentId} requested handoff for conv ${ctx.conversationId} → pendingAction=${action.id} (reason="${reason}")`,
    );

    return {
      output: {
        ok: true,
        status: 'queued_for_processing',
        pendingActionId: action.id,
        preview,
        message:
          'Transferência registrada com sucesso. Atendente humano vai assumir em instantes — fluxo padrão, não é erro.',
        agent_should_say:
          'A mensagem avisando o cliente sobre a transferência JÁ foi enviada pelo sistema. NÃO envie nenhuma outra mensagem — apenas encerre seu turno.',
      },
      // Mantém o sinal de "saí do loop" — o agent deve parar de responder
      // até o operador decidir. Sem isso o LLM seguiria conversando como
      // se tivesse transferido de fato.
      finalAction: 'TRANSFERRED_TO_HUMAN',
    };
  }

  /**
   * Manda o aviso de transferência pro cliente pela fila outbound (mesmo
   * caminho do replyToConversation). Se o contato não tem vínculo no canal,
   * apenas loga e segue — a transferência continua válida.
   */
  private async sendCustomerNotice(ctx: ToolContext): Promise<void> {
    const binding = await this.prisma.contactChannel.findFirst({
      where: { contactId: ctx.contactId, channelId: ctx.channelId },
      select: { externalId: true },
    });
    if (!binding?.externalId) {
      this.logger.warn(
        `sem contactChannel p/ contato ${ctx.contactId} no canal ${ctx.channelId} — pulando aviso de transferência`,
      );
      return;
    }

    const text = CUSTOMER_HANDOFF_NOTICE;
    const message = await this.prisma.message.create({
      data: {
        conversationId: ctx.conversationId,
        direction: MessageDirection.OUTBOUND,
        type: MessageContentType.TEXT,
        content: { text },
        status: MessageStatus.QUEUED,
        senderName: 'Atendimento',
        metadata: { source: 'handoff-notice', runId: ctx.runId },
      },
    });

    await this.prisma.conversation.update({
      where: { id: ctx.conversationId },
      data: { lastMessageAt: new Date() },
    });

    this.realtime.emitToChannel(ctx.channelId, 'message:new', {
      message,
      conversationId: ctx.conversationId,
      contactId: ctx.contactId,
    });
    this.realtime.emitToConversation(ctx.conversationId, 'message:new', {
      message,
    });

    await this.outboundQueue.add(
      'send-outbound',
      {
        messageId: message.id,
        channelId: ctx.channelId,
        contactExternalId: binding.externalId,
        message: { type: MessageContentType.TEXT, content: { text } },
      },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
  }
}
