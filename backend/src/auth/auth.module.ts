import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  CustomerProfile,
  DriverProfile,
  OtpCode,
  RefreshToken,
  Referral,
  Restaurant,
  RestaurantMember,
  Role,
  User,
} from '../database/entities';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';

@Global()
@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (c: ConfigService) => ({ secret: c.get<string>('jwt.secret') }),
    }),
    TypeOrmModule.forFeature([User, Role, RefreshToken, OtpCode, CustomerProfile, DriverProfile, RestaurantMember, Restaurant, Referral]),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [AuthService, JwtStrategy, JwtModule],
})
export class AuthModule {}
