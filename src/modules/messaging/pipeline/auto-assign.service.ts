import { Injectable, Logger } from '@nestjs/common';
import { AgentStatus, ConversationStatus, DistributionRule } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';

/**
 * Atribuição automática de conversa a um vendedor (rodízio / menos ocupado do
 * setor padrão). Vive num serviço próprio porque é chamado de dois lugares:
 * no inbound (lead novo) e no chatbot (quando a triagem transfere pra humano).
 */
@Injectable()
export class AutoAssignService {
  private readonly logger = new Logger(AutoAssignService.name);
  private readonly rrCursor = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtimeGateway: RealtimeGateway,
  ) {}

  async maybeAutoAssign(
    conversationId: string,
    organizationId: string,
    channelId: string,
  ): Promise<void> {
    const [org, channel, conv] = await Promise.all([
      this.prisma.organization.findUnique({
        where: { id: organizationId },
        select: { aiEnabled: true },
      }),
      this.prisma.channel.findUnique({
        where: { id: channelId },
        select: { aiEnabled: true },
      }),
      this.prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { assignedToId: true, status: true, isGroup: true },
      }),
    ]);
    if (!conv || conv.assignedToId || conv.isGroup) return;
    if (conv.status === ConversationStatus.BOT) return;
    const aiOn =
      channel?.aiEnabled === true ||
      (channel?.aiEnabled !== false && org?.aiEnabled === true);
    if (aiOn) return;

    // Setor padrão = pool de roteamento. (Supervisores não devem estar nele.)
    // A regra de distribuição do setor decide COMO escolher o vendedor.
    const department = await this.prisma.department.findFirst({
      where: { organizationId, deletedAt: null },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      select: { id: true, distributionRule: true },
    });
    if (!department) return;
    // MANUAL = ninguém é atribuído automaticamente; fica na fila do setor
    // pra alguém pegar. (Rodízio e Menos ocupado distribuem sozinhos.)
    if (department.distributionRule === DistributionRule.MANUAL) return;

    const where = (onlineOnly: boolean) => ({
      departmentId: department.id,
      isActive: true,
      userOrganization: {
        organizationId,
        ...(onlineOnly ? { agentStatus: AgentStatus.ONLINE } : {}),
      },
    });
    let agents = await this.prisma.departmentAgent.findMany({
      where: where(true),
      include: { userOrganization: { select: { userId: true } } },
      orderBy: { id: 'asc' },
    });
    if (agents.length === 0) {
      agents = await this.prisma.departmentAgent.findMany({
        where: where(false),
        include: { userOrganization: { select: { userId: true } } },
        orderBy: { id: 'asc' },
      });
    }
    if (agents.length === 0) return;

    // Rotação base: cursor por org:setor. Usado direto no RODÍZIO e como
    // desempate justo no MENOS OCUPADO (evita sempre cair no mesmo quando
    // a carga empata).
    const key = `${organizationId}:${department.id}`;
    const cursor = this.rrCursor.get(key) ?? 0;
    this.rrCursor.set(key, cursor + 1);
    const rotated = agents.map((_, i) => agents[(cursor + i) % agents.length]);

    let pick = rotated[0];
    if (department.distributionRule === DistributionRule.LEAST_BUSY) {
      // Menos ocupado: conta as conversas ABERTAS de cada candidato e pega
      // quem tem menos (empate resolvido pela rotação acima).
      const userIds = rotated.map((a) => a.userOrganization.userId);
      const counts = await this.prisma.conversation.groupBy({
        by: ['assignedToId'],
        where: {
          organizationId,
          assignedToId: { in: userIds },
          deletedAt: null,
          status: {
            in: [
              ConversationStatus.PENDING,
              ConversationStatus.OPEN,
              ConversationStatus.WAITING,
              ConversationStatus.BOT,
            ],
          },
        },
        _count: { _all: true },
      });
      const load = new Map(counts.map((c) => [c.assignedToId, c._count._all]));
      let best = Infinity;
      for (const a of rotated) {
        const c = load.get(a.userOrganization.userId) ?? 0;
        if (c < best) {
          best = c;
          pick = a;
        }
      }
    }

    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { assignedToId: pick.userOrganization.userId },
    });
    this.realtimeGateway.emitToChannel(channelId, 'conversation:updated', {
      conversationId,
      assignedToId: pick.userOrganization.userId,
    });
    this.logger.log(
      `auto_assigned conv=${conversationId} -> user=${pick.userOrganization.userId}`,
    );
  }

}
