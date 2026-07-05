import { IsString, IsOptional, IsEnum, IsBoolean, IsInt, Min, Max } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DistributionRule } from '@prisma/client';

export class CreateDepartmentDto {
  @ApiProperty()
  @IsString()
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ enum: DistributionRule })
  @IsOptional()
  @IsEnum(DistributionRule)
  distributionRule?: DistributionRule;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @ApiPropertyOptional({ description: 'SLA de 1ª resposta em minutos (0 = sem SLA). Máx 10080 (7 dias).' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10080)
  slaFirstResponse?: number;

  @ApiPropertyOptional({ description: 'SLA de resolução em minutos (0 = sem SLA). Máx 10080 (7 dias).' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10080)
  slaResolution?: number;
}
