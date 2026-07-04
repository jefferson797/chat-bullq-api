import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SendPublicMessageDto {
  @ApiProperty({ description: 'ID do contato (Contact.id) que receberá a mensagem' })
  @IsString()
  contactId: string;

  @ApiProperty({ description: 'Texto da mensagem (WhatsApp)', maxLength: 4096 })
  @IsString()
  @MinLength(1)
  @MaxLength(4096)
  text: string;

  /**
   * Opcional — força um canal específico. Sem ele, o serviço usa o canal
   * WhatsApp ativo onde o contato tem vínculo (preferindo o da conversa
   * aberta ou mais recente).
   */
  @ApiPropertyOptional({ description: 'ID do canal (Channel.id) a usar' })
  @IsOptional()
  @IsString()
  channelId?: string;
}
