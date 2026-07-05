import { IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AddDepartmentAgentDto {
  @ApiProperty({ description: 'User id (cuid) of the agent to add to the department' })
  @IsString()
  @MinLength(1)
  userId: string;
}
