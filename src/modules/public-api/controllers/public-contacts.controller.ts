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
    }
    const contacts = await this.prisma.contact.findMany({
      where,
      select: { id: true, name: true, firstName: true, lastName: true, company: true, phone: true, email: true },
      orderBy: { updatedAt: 'desc' },
      take,
    });
    return { contacts };
  }
}
