import { IsString, MinLength, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ResetMemberPasswordDto {
  @ApiProperty({ description: 'Nova senha do membro (mínimo 6 caracteres)' })
  @IsString()
  @MinLength(6)
  @MaxLength(72) // limite do bcrypt
  newPassword: string;
}
