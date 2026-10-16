import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Faq, Restaurant, RestaurantHours, SiteSetting, SiteSettingRevision } from '../database/entities';
import { SiteAdminController, SitePublicController } from './site.controller';
import { SiteService } from './site.service';

/** General settings of the website: logo and icons, title, footer, meta tags, SEO / GEO / AEO / AIO, analytics ids, custom CSS / JavaScript. docs/site-settings.md */
@Module({
  imports: [TypeOrmModule.forFeature([SiteSetting, SiteSettingRevision, Restaurant, RestaurantHours, Faq])],
  controllers: [SiteAdminController, SitePublicController],
  providers: [SiteService],
  exports: [SiteService],
})
export class SiteModule {}
