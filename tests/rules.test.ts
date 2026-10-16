import { expect, test } from 'bun:test';
import { defaultPolicy } from '../src/contracts/intake';
import { starterRules } from '../src/rules/defaults';
import {
  canonicalUrl,
  matchRule,
  ruleFileSchema,
  ruleSchema,
} from '../src/rules/schema';
import { trustedSender } from '../src/security';
import { fakeStorage } from './support';

test('rules are declarative and preserve identity parameters / fragment routing', () => {
  expect(() =>
    ruleSchema.parse({ ...starterRules[0], script: 'stealTokens()' }),
  ).toThrow();
  expect(() =>
    ruleSchema.parse({
      ...starterRules[0],
      identityPolicy: {
        ...defaultPolicy,
        queryParams: ['id'],
        dropQueryParams: ['id'],
      },
    }),
  ).toThrow();
  expect(
    canonicalUrl('https://site.test/jobs?id=1&id=2&utm_source=x#/job/1', {
      ...defaultPolicy,
      queryMode: 'keep-listed',
      queryParams: ['id'],
    }),
  ).toBe('https://site.test/jobs?id=1&id=2#/job/1');
});
test('exact hostname/path matching never silently chooses between ambiguous rules', () => {
  const rule = starterRules[0];
  const url = 'https://www.linkedin.com/jobs/view/123/';
  expect(matchRule([rule], url).id).toBe(rule.id);
  expect(() =>
    matchRule([rule], 'https://www.linkedin.com.evil.test/jobs/view/123'),
  ).toThrow('No matching');
  expect(() => matchRule([rule, { ...rule, id: 'other' }], url)).toThrow(
    'Ambiguous',
  );
  expect(matchRule([rule, { ...rule, id: 'other' }], url, 'other').id).toBe(
    'other',
  );
  expect(
    ruleFileSchema.safeParse({ schemaVersion: 1, rules: [rule, rule] }).success,
  ).toBe(false);
});
test('provider ID extraction accepts bounded query/path/attribute configs, never code', () => {
  for (const providerId of [
    { type: 'query', name: 'jk' },
    { type: 'path', segment: 3 },
    { type: 'attribute', selector: 'main', attribute: 'data-job-id' },
  ])
    expect(
      ruleSchema.safeParse({ ...starterRules[0], providerId }).success,
    ).toBe(true);
  expect(
    ruleSchema.safeParse({
      ...starterRules[0],
      providerId: { type: 'eval', script: 'alert(1)' },
    }).success,
  ).toBe(false);
});
test('content scripts, other extensions and subframes cannot message the credential-owning worker', () => {
  fakeStorage();
  expect(
    trustedSender({
      id: 'test-extension',
      url: 'chrome-extension://test-extension/popup/index.html',
    }),
  ).toBe(true);
  for (const sender of [
    {
      id: 'test-extension',
      url: 'https://www.linkedin.com/jobs/view/123',
      tab: { id: 1 },
    },
    {
      id: 'other',
      url: 'chrome-extension://test-extension/options/index.html',
    },
    {
      id: 'test-extension',
      url: 'chrome-extension://test-extension/options/index.html',
      frameId: 1,
    },
    {
      id: 'test-extension',
      url: 'chrome-extension://test-extension/options/index.html.evil',
    },
  ])
    expect(trustedSender(sender as chrome.runtime.MessageSender)).toBe(false);
});
