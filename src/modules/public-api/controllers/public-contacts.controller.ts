import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { ApiKeyAuthGuard } from '../../../common/guards';
import { CurrentOrg } from '../../../common/decorators';
import { PrismaService } from '../../../database/prisma.service';

/**
 * Lista de contatos da organização para CRM/ERP externo (ex.: Exatek) importar.
 * Somente leitura, escopado pela organização da API key. Devolve campos enxutos.
 */
@ApiTags('Public API · Contacts')
@ApiSecurity('api-key')
@UseGuards(ApiKeyAuthGuard)
@Controller('public/contacts')
export class PublicContactsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'List organization contacts (for external import)' })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async list(
    @CurrentOrg('id') orgId: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
  ) {
    const take = Math.min(Math.max(parseInt(limit || '20', 10) || 20, 1), 50);
    const where: Prisma.ContactWhereInput = { organizationId: orgId, deletedAt: null };
    if (search?.trim()) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search } },
        { email: { contains: search, mode: 'insensitive' } },
      ];
      // Telefones são guardados como chegam do provider — às vezes com máscara
      // ("+55 11 98641-8358"). Busca numérica compara só dígitos dos dois lados,
      // senão "86418358" não acha "8641-8358".
      const digits = search.replace(/\D/g, '');
      if (digits.length >= 4) {
        const rows = await this.prisma.$queryRaw<{ id: string }[]>`
          SELECT id FROM contacts
          WHERE organization_id = ${orgId}
            AND deleted_at IS NULL
            AND regexp_replace(coalesce(phone, ''), '\\D', '', 'g') LIKE ${'%' + digits + '%'}
          LIMIT ${take}
        `;
        if (rows.length) where.OR.push({ id: { in: rows.map((r) => r.id) } });
      }
    }
    const contacts = await this.prisma.contact.findMany({
      where,
      select: { id: true, name: true, firstName: true, lastName: true, company: true, phone: true, email: true },
      orderBy: { updatedAt: 'desc' },
      take,
    });
    return { contacts };
  }

  /**
   * Refs do Google Ads (gclid capturado da 1ª mensagem, ver inbound processor)
   * pra um lote de contatos — usado pelo export de conversões offline do ERP.
   */
  @Get('ads-refs')
  @ApiOperation({ summary: 'Google Ads click refs (gclid) for a batch of contact ids' })
  @ApiQuery({ name: 'ids', required: true, description: 'comma-separated contact ids (max 500)' })
  async adsRefs(@CurrentOrg('id') orgId: string, @Query('ids') ids?: string) {
    const list = (ids || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 500);
    if (!list.length) return { refs: [] };
    const rows = await this.prisma.contact.findMany({
      where: { organizationId: orgId, id: { in: list }, deletedAt: null },
      select: { id: true, metadata: true },
    });
    const refs = rows
      .map((r) => {
        const meta = (r.metadata ?? {}) as Record<string, any>;
        return { id: r.id, gclid: meta.gclid ?? null, gclidCapturedAt: meta.gclidCapturedAt ?? null };
      })
      .filter((r) => r.gclid);
    return { refs };
  }
}
