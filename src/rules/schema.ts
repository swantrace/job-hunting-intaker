import { z } from 'zod';
import { defaultPolicy, policySchema } from '../contracts/intake';

const selectors = z.array(z.string().trim().min(1).max(300)).max(20);
const attribute = z
  .string()
  .regex(/^(?:content|datetime|href|data-[a-z0-9-]+)$/);
const fieldSchema = z
  .strictObject({
    selectors,
    mode: z.enum(['text', 'innerText', 'attribute']).default('text'),
    attribute: attribute.optional(),
    prefer: z.enum(['json-ld', 'css-selector']).default('json-ld'),
  })
  .refine(
    (v) => v.mode !== 'attribute' || !!v.attribute,
    'Choose an attribute.',
  );
export const ruleSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]{1,100}$/),
  version: z.number().int().min(1),
  label: z.string().trim().min(1).max(120),
  enabled: z.boolean(),
  hostnames: z
    .array(
      z
        .string()
        .toLowerCase()
        .regex(/^(?:localhost|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)$/),
    )
    .min(1)
    .max(10),
  pathPattern: z.string().startsWith('/').max(200),
  routePattern: z.string().max(200).optional(),
  rootSelectors: selectors.min(1),
  excludeSelectors: selectors.default([]),
  applicationSource: z.string().max(150),
  fields: z.strictObject({
    rawText: fieldSchema,
    jobTitle: fieldSchema.optional(),
    companyName: fieldSchema.optional(),
    location: fieldSchema.optional(),
    postedDate: fieldSchema.optional(),
    salary: fieldSchema.optional(),
  }),
  providerId: z
    .discriminatedUnion('type', [
      z.strictObject({
        type: z.literal('query'),
        name: z.string().min(1).max(120),
      }),
      z.strictObject({
        type: z.literal('path'),
        segment: z.number().int().min(0).max(30),
      }),
      z.strictObject({
        type: z.literal('attribute'),
        selector: z.string().min(1).max(300),
        attribute,
      }),
    ])
    .optional(),
  identityPolicy: policySchema.default(defaultPolicy),
});
export type SiteRule = z.infer<typeof ruleSchema>;
export const ruleFileSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    rules: z.array(ruleSchema).max(100),
  })
  .refine(
    (value) =>
      new Set(value.rules.map((rule) => rule.id)).size === value.rules.length,
    'Rule IDs must be unique.',
  );
export function globMatches(pattern: string, value: string) {
  return new RegExp(
    `^${pattern
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
  ).test(value);
}
export function matchRule(rules: SiteRule[], url: string, chosenId?: string) {
  const parsed = new URL(url);
  const matching = rules.filter(
    (rule) =>
      rule.enabled &&
      rule.hostnames.includes(parsed.hostname) &&
      globMatches(rule.pathPattern, parsed.pathname) &&
      (!rule.routePattern || globMatches(rule.routePattern, parsed.hash)),
  );
  if (chosenId) {
    const chosen = matching.find((rule) => rule.id === chosenId);
    if (!chosen) throw new Error('Chosen rule does not match this page.');
    return chosen;
  }
  if (matching.length !== 1)
    throw new Error(
      matching.length
        ? 'Ambiguous rule: choose a rule explicitly.'
        : 'No matching website rule. Add one in Settings.',
    );
  return matching[0];
}
export function canonicalUrl(
  sourceUrl: string,
  policy: SiteRule['identityPolicy'],
) {
  const url = new URL(sourceUrl);
  for (const key of [...new Set(url.searchParams.keys())])
    if (
      policy.dropQueryParams.includes(key) ||
      (policy.queryMode === 'keep-listed' && !policy.queryParams.includes(key))
    )
      url.searchParams.delete(key);
  if (policy.fragmentMode === 'drop') url.hash = '';
  return url.href;
}
