import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { SessionTokenService } from './session-token.service.js';

@Module({
  controllers: [AuthController],
  providers: [AuthService, SessionTokenService],
  exports: [AuthService, SessionTokenService],
})
export class AuthModule {}
