import { Module, Global } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import type { SignOptions } from 'jsonwebtoken';
import { RealtimeGateway } from './realtime.gateway';
import { PresenceService } from './presence.service';
import { AuthModule } from '../auth/auth.module';

@Global()
@Module({
  imports: [
    // A reconferência da conexão ao vivo ajusta a conta pelo TunerID.
    AuthModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET')!,
        signOptions: {
          expiresIn: config.get<string>('JWT_EXPIRATION', '15m') as SignOptions['expiresIn'],
        },
      }),
    }),
  ],
  providers: [RealtimeGateway, PresenceService],
  exports: [RealtimeGateway, PresenceService],
})
export class RealtimeModule {}
