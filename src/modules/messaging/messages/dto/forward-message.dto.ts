import { IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Encaminhamento estilo WhatsApp: pega uma mensagem existente e reenvia o
 * mesmo conteúdo (texto ou mídia) para outra conversa. O destino é uma
 * conversa interna já existente — a seleção de alvo acontece na UI.
 */
export class ForwardMessageDto {
  @ApiProperty({
    example: 'conversation-id-here',
    description: 'Conversa de destino para onde a mensagem será encaminhada.',
  })
  @IsString()
  conversationId: string;
}
