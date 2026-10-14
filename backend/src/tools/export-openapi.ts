import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { AppModule } from '../app.module';
import { API_PREFIX, API_PREFIX_EXCLUDE } from '../common/api-prefix';
import { applyObserved, buildOpenApiConfig, enrichOpenApi, sortKeysDeep } from '../common/openapi';

/**
 * Writes the OpenAPI description of the API as files for frontend developers and code generators:
 *
 *   docs/openapi/openapi.json   docs/openapi/openapi.yaml
 *
 *   cd backend && npm run openapi:export        (needs the database from backend/.env: the app is booted, not started)
 *
 * It must run from a build made by the Nest CLI (the npm script does that): the @nestjs/swagger compiler plugin configured in
 * nest-cli.json is what reads the request DTOs (fields, types, required, limits from class-validator) and the declared return types.
 * Output keys are sorted, so the files only change when the API changes.
 */
async function main() {
  const outDir = resolve(process.env.OPENAPI_OUT_DIR || join(process.cwd(), '..', 'docs', 'openapi'));
  const app = await NestFactory.create(AppModule, { logger: ['error'] });
  app.setGlobalPrefix(API_PREFIX, { exclude: API_PREFIX_EXCLUDE });
  await app.init();
  const enriched = enrichOpenApi(SwaggerModule.createDocument(app, buildOpenApiConfig()));
  await app.close();

  mkdirSync(outDir, { recursive: true });
  // response shapes observed on demo data (npm run openapi:observe), committed next to the output
  const observedFile = join(outDir, 'openapi.responses.json');
  const observed = existsSync(observedFile) ? applyObserved(enriched, JSON.parse(readFileSync(observedFile, 'utf8'))) : 0;
  const doc = sortKeysDeep(enriched);
  writeFileSync(join(outDir, 'openapi.json'), JSON.stringify(doc, null, 2) + '\n');
  // js-yaml is a dependency of @nestjs/swagger
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const yaml = require('js-yaml');
  writeFileSync(join(outDir, 'openapi.yaml'), yaml.dump(doc, { lineWidth: -1, noRefs: true }));
  const ops = Object.values(doc.paths).reduce((n, p: any) => n + Object.keys(p).length, 0);
  // eslint-disable-next-line no-console
  console.log(`OpenAPI written to ${outDir}: ${Object.keys(doc.paths).length} paths, ${ops} operations, ${Object.keys(doc.components?.schemas ?? {}).length} schemas, ${observed} operations with an observed response`);
}

main().then(
  () => process.exit(0),
  (e) => {
    // eslint-disable-next-line no-console
    console.error('OpenAPI export failed:', e);
    process.exit(1);
  },
);
