import { BadRequestException, Controller, Global, Injectable, Module, Post, UnsupportedMediaTypeException, UploadedFile, UseInterceptors } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { Repository } from 'typeorm';
import { CurrentUser } from '../common/decorators';
import { AuthUser } from '../common/auth.types';
import { UploadedFile as UploadedFileRow } from '../database/entities';
import { memoryStorage } from 'multer';
import { existsSync, mkdirSync } from 'fs';
import { writeFile } from 'fs/promises';
import { extname, join } from 'path';
import { v4 as uuid } from 'uuid';

/**
 * Upload policy: the server decides what a file IS by its magic bytes (never by the client MIME type or extension),
 * stores it under a random uuid name with the extension of the DETECTED type, and serves it with safe headers.
 * SVG / HTML / JS / executables are rejected outright (SVG is an XML document that can carry script).
 */
type Kind = 'image' | 'pdf' | 'csv';
const TYPES: Record<string, { ext: string; mime: string; kind: Kind; maxBytes: number }> = {
  jpg: { ext: '.jpg', mime: 'image/jpeg', kind: 'image', maxBytes: 8 * 1024 * 1024 },
  png: { ext: '.png', mime: 'image/png', kind: 'image', maxBytes: 8 * 1024 * 1024 },
  gif: { ext: '.gif', mime: 'image/gif', kind: 'image', maxBytes: 5 * 1024 * 1024 },
  webp: { ext: '.webp', mime: 'image/webp', kind: 'image', maxBytes: 8 * 1024 * 1024 },
  heic: { ext: '.heic', mime: 'image/heic', kind: 'image', maxBytes: 10 * 1024 * 1024 },
  pdf: { ext: '.pdf', mime: 'application/pdf', kind: 'pdf', maxBytes: 10 * 1024 * 1024 },
  csv: { ext: '.csv', mime: 'text/csv', kind: 'csv', maxBytes: 2 * 1024 * 1024 },
};

export function detectFileType(buf: Buffer, clientName: string): keyof typeof TYPES | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  const head6 = buf.subarray(0, 6).toString('latin1');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp' && /^(heic|heix|hevc|hevx|mif1|msf1|heim|heis)$/.test(buf.subarray(8, 12).toString('latin1'))) return 'heic';
  // CSV: only when the client says .csv AND the content is plain UTF-8 text (no NULs, no markup start)
  if (extname(clientName).toLowerCase() === '.csv') {
    const sample = buf.subarray(0, Math.min(buf.length, 4096));
    if (!sample.includes(0) && !/^\s*<[a-zA-Z!?]/.test(sample.toString('utf8'))) return 'csv';
  }
  return null;
}

export const uploadStaticOptions = {
  index: false,
  dotfiles: 'deny' as const,
  redirect: false,
  maxAge: '1h',
  setHeaders: (res: any, path: string) => {
    const ext = extname(path).toLowerCase();
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // an uploaded file must never be able to run script in our origin even if a browser renders it
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    const inlineImage = ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext);
    if (inlineImage) {
      res.setHeader('Content-Disposition', 'inline');
    } else {
      // pdf, csv, heic, and anything legacy (svg/html uploaded before this policy) are download-only
      res.setHeader('Content-Disposition', 'attachment');
      if (!['.pdf', '.csv', '.heic'].includes(ext)) res.setHeader('Content-Type', 'application/octet-stream');
    }
  },
};

@Injectable()
export class UploadsService {
  readonly dir: string;
  /** Private area (NOT served statically): delivery proof photos are moved here once they become evidence. */
  readonly privateDir: string;
  constructor(
    private config: ConfigService,
    @InjectRepository(UploadedFileRow) private registry: Repository<UploadedFileRow>,
  ) {
    this.dir = join(process.cwd(), config.get<string>('uploads.dir') ?? 'uploads');
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    this.privateDir = join(process.cwd(), config.get<string>('uploads.privateDir') ?? 'private-uploads');
    if (!existsSync(join(this.privateDir, 'proofs'))) mkdirSync(join(this.privateDir, 'proofs'), { recursive: true });
  }
  publicUrl(filename: string) {
    return `${this.config.get('publicUrl')}/uploads/${filename}`;
  }

  /**
   * Stores one uploaded file the same way POST /uploads does: the type is detected from the bytes (never from the client), the size is limited per type, the file gets a random name
   * and the registry remembers who uploaded it. `only` narrows what is accepted (the site settings take pictures only).
   */
  async store(file: { buffer: Buffer; originalname: string; size: number }, user: AuthUser | undefined, only?: Kind[]) {
    const type = detectFileType(file.buffer, file.originalname);
    if (!type) throw new UnsupportedMediaTypeException('Unsupported or unrecognised file type (allowed: JPG, PNG, GIF, WebP, HEIC, PDF, CSV)');
    const t = TYPES[type];
    if (only && !only.includes(t.kind)) throw new UnsupportedMediaTypeException(`This needs a ${only.join(' or ')} file`);
    if (file.size > t.maxBytes) throw new BadRequestException(`File too large (max ${Math.round(t.maxBytes / 1024 / 1024)} MB for this type)`);
    const filename = `${uuid()}${t.ext}`; // random server-side name; the client name is never used on disk
    await writeFile(join(this.dir, filename), file.buffer, { flag: 'wx', mode: 0o640 });
    // registry: who uploaded which file (a delivery proof photo must have been uploaded by the delivering driver)
    await this.registry.insert({ filename, userId: user?.id ?? null, userType: user?.type ?? null, sha256: createHash('sha256').update(file.buffer).digest('hex'), size: file.size, mimetype: t.mime });
    return { url: this.publicUrl(filename), filename, originalName: file.originalname.replace(/[^\w.\- ]/g, '_').slice(0, 100), size: file.size, mimetype: t.mime, type };
  }
}

/**
 * POST /api/v1/uploads   (multipart, field "file")  -> { url, filename, size, mimetype }
 * Any authenticated user can upload: menu photos, driver documents, proof of delivery, ticket attachments.
 * Files are served from /uploads. Replace disk storage with S3 (ca-central-1, private bucket + signed URLs) in production.
 */
@ApiTags('Uploads')
@ApiBearerAuth()
@Controller('uploads')
class UploadsController {
  constructor(private svc: UploadsService) {}

  @Post()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 5, parts: 8, fieldSize: 1024, headerPairs: 30 },
    }),
  )
  async upload(@UploadedFile() file: Express.Multer.File, @CurrentUser() user: AuthUser) {
    if (!file) throw new BadRequestException('file is required');
    const { type: _type, ...saved } = await this.svc.store(file, user);
    void _type;
    return saved;
  }
}

@Global()
@Module({ imports: [TypeOrmModule.forFeature([UploadedFileRow])], providers: [UploadsService], controllers: [UploadsController], exports: [UploadsService] })
export class UploadsModule {}
