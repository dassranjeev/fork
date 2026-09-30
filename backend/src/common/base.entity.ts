import { Column, CreateDateColumn, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/** Maps PostgreSQL numeric -> JS number. */
export const numeric = {
  to: (v?: number | null) => v,
  from: (v?: string | null) => (v === null || v === undefined ? v : parseFloat(v)),
};

/** Money column: numeric(12,2), CAD dollars. */
export const MoneyColumn = (opts: { nullable?: boolean; default?: number } = {}) =>
  Column({
    type: 'numeric',
    precision: 12,
    scale: 2,
    transformer: numeric,
    nullable: opts.nullable ?? false,
    ...(opts.nullable ? {} : { default: opts.default ?? 0 }),
  });

/** Percentage / rate column: numeric(6,3). */
export const PctColumn = (opts: { nullable?: boolean; default?: number } = {}) =>
  Column({
    type: 'numeric',
    precision: 6,
    scale: 3,
    transformer: numeric,
    nullable: opts.nullable ?? false,
    ...(opts.nullable ? {} : { default: opts.default ?? 0 }),
  });

/** Latitude / longitude column. */
export const GeoColumn = (nullable = true) => Column({ type: 'double precision', nullable });

export abstract class BaseEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
