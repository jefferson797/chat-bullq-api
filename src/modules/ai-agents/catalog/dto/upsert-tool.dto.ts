import {
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * A Tool is a CONNECTION provider (HTTP base+auth, or SQL DSN).
 * It does NOT have parameters or a name visible to the LLM. Skills bind to a Tool
 * and provide the actual function definition.
 */
export class UpsertToolDto {
  @ApiProperty({ example: 'ERP Exatek' })
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name!: string;

  @ApiProperty()
  @IsString()
  @MinLength(5)
  description!: string;

  @ApiProperty({
    enum: ['CUSTOM_HTTP', 'CUSTOM_SQL'],
    description: 'CUSTOM_HTTP = REST API. CUSTOM_SQL = Postgres connection.',
  })
  @IsIn(['CUSTOM_HTTP', 'CUSTOM_SQL'])
  source!: 'CUSTOM_HTTP' | 'CUSTOM_SQL';

  // ── HTTP provider fields ────────────────────────────────────────

  @ApiPropertyOptional({ example: 'https://api.exemplo.com.br/api/v1' })
  @IsOptional()
  @IsString()
  httpBaseUrl?: string;

  @ApiPropertyOptional({
    description:
      'Headers padrão (auth, content-type). Templates: {{env.X}}. Ex: {"Authorization":"Bearer {{env.MINHA_API_KEY}}"}',
  })
  @IsOptional()
  @IsObject()
  httpHeaders?: Record<string, string>;

  // ── SQL provider fields ─────────────────────────────────────────

  @ApiPropertyOptional({
    example: 'HOTWEBINAR_DB_URL',
    description: 'Nome da env var no servidor com a connection string Postgres.',
  })
  @IsOptional()
  @IsString()
  sqlConnectionRef?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
