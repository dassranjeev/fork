import { RequestMethod } from '@nestjs/common';

/** URL prefix of every API route, and the few public files that live outside it. Shared by main.ts and the OpenAPI export tool. */
export const API_PREFIX = 'api/v1';
export const API_PREFIX_EXCLUDE = [
  { path: 'uploads/(.*)', method: RequestMethod.GET },
  { path: 'assistant/widget.js', method: RequestMethod.GET },
  { path: 'assistant/forksy-icon.png', method: RequestMethod.GET },
];
