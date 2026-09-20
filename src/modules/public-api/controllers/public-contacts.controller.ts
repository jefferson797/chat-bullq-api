import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
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

  /**
   * Leads vindos do Google Ads numa janela: todo contato cuja 1ª mensagem trouxe
   * um gclid (capturado a partir de `since`). É o degrau "lead entrou" do funil
   * offline — o ERP transforma isto no CSV "Lead (Conversas)" pro Google Ads.
   */
  @Get('ads-leads')
  @ApiOperation({ summary: 'Contacts whose first message carried a Google Ads gclid, captured since a date' })
  @ApiQuery({ name: 'since', required: true, description: 'ISO date/time (inclusive)' })
  @ApiQuery({ name: 'limit', required: false, description: 'max rows (default 1000, max 5000)' })
  async adsLeads(
    @CurrentOrg('id') orgId: string,
    @Query('since') since?: string,
    @Query('limit') limit?: string,
  ) {
    const sinceDate = since ? new Date(since) : null;
    if (!sinceDate || Number.isNaN(sinceDate.getTime())) {
      throw new BadRequestException('since inválido (use ISO 8601)');
    }
    const take = Math.min(Math.max(parseInt(limit || '1000', 10) || 1000, 1), 5000);
    // gclidCapturedAt é gravado como ISO string dentro do JSON de metadata (inbound
    // processor); comparação textual de ISO em UTC ordena certo.
    const rows = await this.prisma.$queryRaw<{ id: string; phone: string | null; gclid: string; captured_at: string }[]>`
      SELECT id, phone,
             metadata->>'gclid' AS gclid,
             metadata->>'gclidCapturedAt' AS captured_at
      FROM contacts
      WHERE organization_id = ${orgId}
        AND deleted_at IS NULL
        AND metadata->>'gclid' IS NOT NULL
        AND metadata->>'gclidCapturedAt' >= ${sinceDate.toISOString()}
      ORDER BY metadata->>'gclidCapturedAt' ASC
      LIMIT ${take}
    `;
    const leads = rows.map((r) => ({ id: r.id, phone: r.phone, gclid: r.gclid, gclidCapturedAt: r.captured_at }));
    return { leads };
  }
}
