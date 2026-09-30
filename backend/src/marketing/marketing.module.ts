import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  Banner,
  Campaign,
  CmsPage,
  CustomerProfile,
  DriverProfile,
  Faq,
  GiftCard,
  MenuItem,
  NotificationTemplate,
  PromoRedemption,
  Promotion,
  Referral,
  Restaurant,
  RestaurantMember,
  User,
} from '../database/entities';
import { PromotionsService } from './promotions.service';
import { PromotionsAdminService } from './promotions.admin';
import { PromotionsAdminController, PublicDealsController, RestaurantPromotionsController } from './promotions.controller';
import { GiftCardsService } from './gift-cards.service';
import { GiftCardsAdminController } from './gift-cards.controller';
import { WalletAccess } from './wallet-access';
import {
  BannersAdminController,
  CmsPagesAdminController,
  ContentService,
  FaqsAdminController,
  PublicBannersController,
  PublicCmsController,
  PublicFaqsController,
} from './content.controller';
import { TemplatesService, NotificationTemplatesController, NotificationMatrixController } from './templates.controller';
import { CampaignsService, CampaignsAdminController, UnsubscribeController } from './campaigns';
import { ReferralsAdminService, ReferralRewardListener, ReferralsAdminController } from './referrals';

/**
 * MarketingModule (docs/ARCHITECTURE.md 'MarketingModule' row).
 * NOT @Global(): PromotionsService / GiftCardsService are still reachable app-wide because other
 * modules resolve them via ModuleRef.get(token, { strict: false }) (see orders/pricing.math.ts
 * `lazyProvider`), which searches the whole DI container rather than only imported modules.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Promotion,
      PromoRedemption,
      CustomerProfile,
      GiftCard,
      Banner,
      CmsPage,
      Faq,
      NotificationTemplate,
      Campaign,
      Referral,
      Restaurant,
      MenuItem,
      User,
      DriverProfile,
      RestaurantMember,
    ]),
  ],
  providers: [
    PromotionsService,
    PromotionsAdminService,
    GiftCardsService,
    WalletAccess,
    ContentService,
    TemplatesService,
    CampaignsService,
    ReferralsAdminService,
    ReferralRewardListener,
  ],
  controllers: [
    PromotionsAdminController,
    RestaurantPromotionsController,
    PublicDealsController,
    GiftCardsAdminController,
    BannersAdminController,
    CmsPagesAdminController,
    FaqsAdminController,
    PublicBannersController,
    PublicCmsController,
    PublicFaqsController,
    NotificationTemplatesController,
    NotificationMatrixController,
    CampaignsAdminController,
    UnsubscribeController,
    ReferralsAdminController,
  ],
  exports: [PromotionsService, GiftCardsService],
})
export class MarketingModule {}
