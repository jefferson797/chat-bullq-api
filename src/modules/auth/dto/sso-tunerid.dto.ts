import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class SsoTunerIdDto {
  /** O bilhete de uso único emitido pelo TunerID. Vale 60 segundos. */
  @ApiProperty()
  @IsString()
  @MinLength(16)
  @MaxLength(200)
  codigo!: string;
}
