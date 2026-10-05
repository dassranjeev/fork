import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../common/base.entity';

/**
 * Immutable EVIDENCE RECORD of one delivery (one row per order). Every column except the review / dispute block is written once,
 * in the same transaction-like step that marks the order DELIVERED, and is never updated afterwards (ProofService has no code path
 * that edits it). The photo FILE lives in the private proof directory (not under /uploads) and is purged after the retention window;
 * the row (hash, coordinates, timestamps, flags) is kept.
 */
@Entity('delivery_proofs')
export class DeliveryProof extends BaseEntity {
  @Index({ unique: true })
  @Column({ type: 'uuid' })
  orderId: string;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  driverId: string | null;

  @Index()
  @Column({ type: 'uuid' })
  customerId: string;

  /** DropoffMethod chosen by the customer at delivery time */
  @Column({ type: 'varchar' })
  method: string;

  /** PIN | PHOTO | PIN_AND_PHOTO | EXCEPTION | NONE */
  @Column({ type: 'varchar' })
  proofType: string;

  /** STRONG = customer PIN, or a clean in-geofence photo. WEAK = exception path, any integrity flag, or no proof. */
  @Column({ type: 'varchar', default: 'STRONG' })
  strength: 'STRONG' | 'WEAK';

  @Column({ default: false })
  pinVerified: boolean;

  @Column({ type: 'varchar', nullable: true })
  exceptionReason: string | null;

  @Column({ type: 'text', nullable: true })
  exceptionNote: string | null;

  // ---- photo (file is private; only the hash/metadata outlive the retention window) ----
  @Column({ type: 'varchar', nullable: true })
  photoFile: string | null;

  @Index({ unique: true, where: '"photoSha256" IS NOT NULL' })
  @Column({ type: 'varchar', length: 64, nullable: true })
  photoSha256: string | null;

  @Column({ type: 'varchar', nullable: true })
  photoMime: string | null;

  @Column({ type: 'int', nullable: true })
  photoBytes: number | null;

  @Column({ default: false })
  photoExifStripped: boolean;

  @Column({ type: 'double precision', nullable: true })
  photoLat: number | null;

  @Column({ type: 'double precision', nullable: true })
  photoLng: number | null;

  @Column({ type: 'double precision', nullable: true })
  photoAccuracyM: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  photoCapturedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  photoPurgedAt: Date | null;

  // ---- location checks ----
  @Column({ type: 'double precision', nullable: true })
  dropoffLat: number | null;

  @Column({ type: 'double precision', nullable: true })
  dropoffLng: number | null;

  /** where the driver claimed to be (photo location, else device GPS sent with the request, else last server GPS) */
  @Column({ type: 'double precision', nullable: true })
  claimedLat: number | null;

  @Column({ type: 'double precision', nullable: true })
  claimedLng: number | null;

  /** metres from the drop-off address coordinates to the claimed location */
  @Column({ type: 'double precision', nullable: true })
  distanceMeters: number | null;

  /** metres between the claimed location and the driver's last SERVER-side GPS fix (null = no fresh fix) */
  @Column({ type: 'double precision', nullable: true })
  serverGpsDistanceMeters: number | null;

  @Column({ type: 'int', nullable: true })
  geofenceMeters: number | null;

  // ---- server timestamps ----
  @Column({ type: 'timestamptz', nullable: true })
  arrivedCustomerAt: Date | null;

  @Column({ type: 'timestamptz' })
  deliveredAt: Date;

  /** summary of the last ~10 min of the driver's GPS log: { windowMinutes, count, minDistanceMeters, points:[{lat,lng,at,distanceMeters}] } */
  @Column({ type: 'jsonb', nullable: true })
  breadcrumb: Record<string, any> | null;

  /** { ip, userAgent } of the delivered request */
  @Column({ type: 'jsonb', nullable: true })
  device: Record<string, any> | null;

  /** what the customer asked for at delivery time: { method, dropoffNotes, accessCodeProvided, requiresPin } */
  @Column({ type: 'jsonb', nullable: true })
  instructions: Record<string, any> | null;

  /** WEAK_PROOF | GEOFENCE_OVERRIDE | GPS_MISMATCH | GPS_UNVERIFIED | LOW_ACCURACY | STAFF_FORCED ... */
  @Column({ type: 'jsonb', default: [] })
  flags: string[];

  // ---- review / dispute block (the only part that is ever updated) ----
  @Index()
  @Column({ type: 'varchar', default: 'NONE' })
  reviewStatus: 'NONE' | 'NEEDS_REVIEW' | 'REVIEWED';

  @Column({ type: 'uuid', nullable: true })
  reviewedById: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  reviewedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  reviewNote: string | null;

  /** UPHELD_DELIVERED | NOT_DELIVERED | INCONCLUSIVE */
  @Column({ type: 'varchar', nullable: true })
  disputeOutcome: string | null;

  @Column({ type: 'uuid', nullable: true })
  disputeOutcomeById: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  disputeOutcomeAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  disputeTicketId: string | null;
}

/** Registry of files stored through POST /uploads: who uploaded what, so a driver can only use a photo that THEY uploaded as proof. */
@Entity('uploaded_files')
export class UploadedFile extends BaseEntity {
  @Index({ unique: true })
  @Column()
  filename: string;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  @Column({ type: 'varchar', nullable: true })
  userType: string | null;

  @Column({ type: 'varchar', length: 64 })
  sha256: string;

  @Column({ type: 'int' })
  size: number;

  @Column()
  mimetype: string;
}
