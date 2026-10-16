import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../common/base.entity';

/**
 * The saved sections of the website's General settings (docs/site-settings.md): one row per section (general, branding, seo, geo, aeo, aio, footer, integrations, scripts).
 * A section that has never been saved has no row: the defaults of backend/src/site/site.schema.ts apply.
 */
@Entity('site_settings')
export class SiteSetting extends BaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 40 })
  section: string;

  @Column({ type: 'jsonb' })
  value: any;

  /** goes up by one with every change; the revision of the same number holds this value */
  @Column({ type: 'int', default: 1 })
  version: number;

  @Column({ type: 'uuid', nullable: true })
  updatedBy: string | null;

  @Column({ type: 'varchar', nullable: true })
  updatedByName: string | null;
}

/** Every saved value of a section, newest 50 kept: a change can be looked at and put back (custom code that breaks the site is undone in one call). */
@Entity('site_setting_revisions')
@Index(['section', 'version'], { unique: true })
export class SiteSettingRevision extends BaseEntity {
  @Column({ type: 'varchar', length: 40 })
  section: string;

  @Column({ type: 'int' })
  version: number;

  @Column({ type: 'jsonb' })
  value: any;

  @Column({ type: 'uuid', nullable: true })
  createdBy: string | null;

  @Column({ type: 'varchar', nullable: true })
  createdByName: string | null;

  /** what happened: "saved", "reset to defaults", "restored version 4", "logo uploaded" ... */
  @Column({ type: 'varchar', nullable: true })
  note: string | null;
}
