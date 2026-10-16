import { expect, test } from 'bun:test';
import {
  extractionTimeoutMs,
  withExtractionTimeout,
} from '../src/extraction/timeout';

test('extraction returns results and propagates immediate failures', async () => {
  expect(await withExtractionTimeout(async () => 'captured')).toBe('captured');
  await expect(
    withExtractionTimeout(async () => {
      throw new Error('Missing permission');
    }),
  ).rejects.toThrow('Missing permission');
});

test('an unresponsive page reports its current diagnostic stage and subsequent extraction continues', async () => {
  expect(extractionTimeoutMs).toBe(15000);
  let stage = 'Reading tab details';
  await expect(
    withExtractionTimeout(
      () => {
        stage = 'Waiting for page extraction result';
        return new Promise<never>(() => {});
      },
      () => `Stage: ${stage}; tab 42`,
      10,
    ),
  ).rejects.toThrow('Stage: Waiting for page extraction result; tab 42');
  expect(await withExtractionTimeout(async () => 'next page')).toBe(
    'next page',
  );
});
