import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsNumber, IsOptional, IsString, Min } from 'class-validator';

/** Aviso do ERP: este contato fechou um pedido. */
export class RegistrarCompraDto {
  @ApiPropertyOptional({ description: 'Número do pedido no ERP — usado pra não contar duas vezes', example: 'E260925-03' })
  @IsOptional()
  @IsString()
  pedido?: string;

  @ApiPropertyOptional({ description: 'Valor do pedido' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  valor?: number;

  @ApiPropertyOptional({ description: 'Quando o pedido foi criado (ISO 8601). Padrão: agora.' })
  @IsOptional()
  @IsISO8601()
  em?: string;
}
