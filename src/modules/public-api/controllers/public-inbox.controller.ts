import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ApiKeyAuthGuard } from '../../../common/guards';
import { CurrentOrg } from '../../../common/decorators';
import { PublicInboxService } from '../services/public-inbox.service';

const verdade = (v?: string) => v === 'true' || v === '1';

@ApiTags('Public API · Inbox')
@ApiSecurity('api-key')
@UseGuards(ApiKeyAuthGuard)
@Controller('public/inbox')
export class PublicInboxController {
  constructor(private readonly service: PublicInboxService) {}

  @Get('conversas')
  @ApiOperation({
    summary: 'Projeção enxuta da caixa (para vigias externos de SLA e triagem)',
    description:
      'Devolve dado cru — status, dono, horários e a direção da última mensagem. ' +
      'Quem chama decide o que é atraso. Exclui arquivadas e grupos por padrão.',
  })
  @ApiQuery({ name: 'arquivadas', required: false, description: 'true inclui arquivadas' })
  @ApiQuery({ name: 'grupos', required: false, description: 'true inclui grupos' })
  @ApiQuery({ name: 'limite', required: false, description: 'padrão 1500, máximo 5000' })
  conversas(
    @CurrentOrg('id') orgId: string,
    @Query('arquivadas') arquivadas?: string,
    @Query('grupos') grupos?: string,
    @Query('limite') limite?: string,
  ) {
    return this.service.conversas(orgId, {
      incluirArquivadas: verdade(arquivadas),
      incluirGrupos: verdade(grupos),
      limite: limite ? Number(limite) : undefined,
    });
  }
}
