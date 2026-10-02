import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';
import { getMetadataStorage } from 'class-validator';

/**
 * ValidationPipe that is strict about string fields in request bodies.
 *
 * With `enableImplicitConversion` (needed so ?page=2 becomes a number) class-transformer would silently turn
 * `{"identifier": {"$ne": null}}` into the string "[object Object]" and `["a","b"]` into "a,b" before `@IsString()` runs.
 * Here every property declared `@IsString()` must really be a string (or absent / null) in the raw JSON - objects and
 * arrays are refused with a 400, so NoSQL-style operator objects and type-confusion payloads never reach a service.
 */
export class StrictValidationPipe extends ValidationPipe {
  async transform(value: any, metadata: ArgumentMetadata) {
    const type = metadata.metatype as any;
    if (metadata.type === 'body' && value && typeof value === 'object' && !Array.isArray(value) && typeof type === 'function' && ![String, Boolean, Number, Array, Object].includes(type)) {
      const bad: string[] = [];
      for (const m of getMetadataStorage().getTargetValidationMetadatas(type, '', false, false)) {
        if (m.name !== 'isString' || m.each) continue;
        const v = value[m.propertyName];
        if (v !== undefined && v !== null && typeof v === 'object') bad.push(m.propertyName);
      }
      if (bad.length) {
        throw new BadRequestException({ statusCode: 400, message: 'Validation failed', details: bad.map((p) => `${p} must be a string`) });
      }
    }
    return super.transform(value, metadata);
  }
}
