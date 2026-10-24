import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { contactDisplayTitle } from '../../../common/utils/contact-display.util';

/**
 * Projeção enxuta da caixa de entrada para consumo de fora (hoje: os vigias da
 * Exatek, que rodam no servidor do ERP).
 *
 * Por que existe: os vigias precisavam da caixa inteira e só havia a rota
 * autenticada por login, o que obrigaria a guardar a senha de admin do Conversas
 * no ambiente do ERP — e o painel que configura esse ambiente só fala HTTP puro.
 * Com esta rota, a chave de API que o ERP já tem basta, e nenhuma senha nova
 * precisa trafegar.
 *
 * Devolve dado cru e deixa a conta para quem chama: quem decide o que é "atraso"
 * é a política de quem consome, não esta camada. Mandar número mastigado aqui
 * significaria mudar o servidor toda vez que o SLA mudasse de ideia.
 */
@Injectable()
export class PublicInboxService {
  constructor(private readonly prisma: PrismaService) {}

  async conversas(
    organizationId: string,
    opts: { incluirArquivadas?: boolean; incluirGrupos?: boolean; limite?: number } = {},
  ) {
    const limite = Math.min(Math.max(opts.limite ?? 1500, 1), 5000);

    const where: Prisma.ConversationWhereInput = {
      organizationId,
      ...(opts.incluirArquivadas ? {} : { isArchived: false }),
      ...(opts.incluirGrupos ? {} : { isGroup: false }),
    };

    const linhas = await this.prisma.conversation.findMany({
      where,
      orderBy: { lastMessageAt: 'desc' },
      take: limite,
      select: {
        id: true,
        status: true,
        isStuck: true,
        isArchived: true,
        createdAt: true,
        lastMessageAt: true,
        firstResponseAt: true,
        contactId: true,
        contact: { select: { name: true, firstName: true, lastName: true, company: true, phone: true } },
        assignedTo: { select: { id: true, name: true } },
        // Só a última mensagem: é o que diz de quem é a bola. Puxar o histórico
        // inteiro aqui transformaria uma consulta barata numa cara.
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { direction: true, createdAt: true },
        },
      },
    });

    return {
      total: linhas.length,
      limite,
      conversas: linhas.map((c) => ({
        id: c.id,
        contactId: c.contactId,
        nome: contactDisplayTitle(c.contact),
        telefone: c.contact?.phone ?? null,
        status: c.status,
        travada: c.isStuck,
        arquivada: c.isArchived,
        dono: c.assignedTo?.name ?? null,
        donoId: c.assignedTo?.id ?? null,
        criadaEm: c.createdAt,
        ultimaMensagemEm: c.lastMessageAt,
        primeiraRespostaEm: c.firstResponseAt,
        // null quando a conversa não tem mensagem nenhuma — acontece, e quem
        // consome precisa saber a diferença entre "ninguém falou" e "falamos nós".
        ultimaDirecao: c.messages[0]?.direction ?? null,
      })),
    };
  }
}
