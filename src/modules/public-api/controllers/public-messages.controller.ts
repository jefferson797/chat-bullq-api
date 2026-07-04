import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ApiKeyAuthGuard } from '../../../common/guards';
import { CurrentOrg } from '../../../common/decorators';
import { PublicMessagesService } from '../services/public-messages.service';
import { SendPublicMessageDto } from '../dto/send-public-message.dto';

/**
 * Envio de mensagem (texto) para um contato, via API key — usado por sistemas
 * externos (ex.: Exatek ERP avisando "pedido despachado"). A mensagem entra
 * como automação e é entregue pela fila outbound padrão.
 */
@ApiTags('Public API · Messages')
@ApiSecurity('api-key')
@UseGuards(ApiKeyAuthGuard)
@Controller('public/messages')
export class PublicMessagesController {
  constructor(private readonly publicMessages: PublicMessagesService) {}

  @Post()
  @ApiOperation({ summary: 'Send a text message to a contact (system/automation)' })
  async send(@CurrentOrg('id') orgId: string, @Body() dto: SendPublicMessageDto) {
    return this.publicMessages.sendText(orgId, dto);
  }
}
