import { z } from 'zod';

export const limits = {
  maxItems: 20,
  maxBodyBytes: 4194304,
  maxTextCharacters: 60000,
  maxTextBytes: 131072,
};
export const fields = [
  'jobTitle',
  'companyName',
  'location',
  'postedDate',
  'salary',
] as const;
export type Field = (typeof fields)[number];
export const isDate = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;
const text = (max: number) => z.string().trim().max(max).nullable().optional();
export const policySchema = z
  .strictObject({
    version: z.literal(1),
    queryMode: z.enum(['keep-all', 'keep-listed']),
    queryParams: z.array(z.string().min(1).max(120)).max(30),
    dropQueryParams: z.array(z.string().min(1).max(120)).max(30),
    fragmentMode: z.enum(['keep', 'drop']),
  })
  .refine(
    (p) => !p.queryParams.some((q) => p.dropQueryParams.includes(q)),
    'Keep/drop lists must not overlap.',
  );
export const defaultPolicy: z.infer<typeof policySchema> = {
  version: 1,
  queryMode: 'keep-all',
  queryParams: [],
  dropQueryParams: [],
  fragmentMode: 'keep',
};
export const itemSchema = z.strictObject({
  clientItemId: z.uuid(),
  sourceUrl: z
    .string()
    .max(2048)
    .url()
    .refine((value) => {
      const url = URL.parse(value);
      return (
        !!url &&
        ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password
      );
    }),
  rawText: z
    .string()
    .trim()
    .min(1)
    .max(limits.maxTextCharacters)
    .refine(
      (value) => new TextEncoder().encode(value).length <= limits.maxTextBytes,
      'Job text exceeds byte limit.',
    )
    .refine(
      (value) =>
        !/^\s*(?:<!doctype|<html|access denied\b|captcha\b)/i.test(value),
      'Paste job text, not HTML or an error page.',
    ),
  applicationSource: text(150),
  suggestedMetadata: z
    .strictObject({
      jobTitle: text(200),
      companyName: text(200),
      location: text(200),
      postedDate: z.string().refine(isDate).nullable().optional(),
      salary: text(150),
    })
    .optional(),
  capture: z
    .strictObject({
      capturedAt: z.iso.datetime({ offset: true }).optional(),
      ruleId: z.string().max(120).optional(),
      ruleVersion: z.string().max(100).optional(),
      fieldSources: z
        .partialRecord(
          z.enum(fields),
          z.enum(['json-ld', 'css-selector', 'page-url', 'user']),
        )
        .optional(),
    })
    .optional(),
  identity: z
    .strictObject({
      providerJobId: z
        .string()
        .min(1)
        .max(200)
        .regex(/^[\w.-]+$/)
        .optional(),
      policy: policySchema.optional(),
    })
    .optional(),
});
export type CaptureItem = z.infer<typeof itemSchema>;
export type BatchPayload = {
  schemaVersion: 1;
  clientBatchId: string;
  items: CaptureItem[];
};
const statuses = [
  'accepted',
  'queued',
  'processing',
  'completed',
  'duplicate',
  'failed',
  'rejected',
] as const;
export const terminal = new Set<string>([
  'completed',
  'duplicate',
  'failed',
  'rejected',
]);
export const batchStatusSchema = z
  .object({
    schemaVersion: z.literal(1),
    batchId: z.number().int().positive(),
    revision: z.number().int(),
    status: z.enum(['processing', 'completed', 'completed-with-errors']),
    isTerminal: z.boolean(),
    terminalRevision: z.string().nullable(),
    total: z.number().int().min(1).max(20),
    counts: z.record(z.string(), z.number().int().nonnegative()),
    decisionCount: z.number().int().nonnegative(),
    statusUrl: z.string(),
    reviewUrl: z.string(),
    items: z
      .array(
        z.object({
          clientItemId: z.uuid(),
          itemId: z.number().int(),
          status: z.enum(statuses),
          stage: z.string(),
          applicationUrl: z.string().nullable(),
          decisionCount: z.number().int().nonnegative(),
          error: z
            .object({
              code: z.string(),
              message: z.string(),
              fieldErrors: z.unknown().optional(),
            })
            .nullable(),
        }),
      )
      .max(20),
  })
  .superRefine((batch, context) => {
    if (
      batch.items.length !== batch.total ||
      Object.values(batch.counts).reduce((a, b) => a + b, 0) !== batch.total ||
      batch.items.some(
        (item) =>
          batch.counts[item.status] !==
          batch.items.filter((i) => i.status === item.status).length,
      ) ||
      batch.isTerminal !==
        batch.items.every((item) => terminal.has(item.status)) ||
      (batch.isTerminal && !batch.terminalRevision)
    )
      context.addIssue({
        code: 'custom',
        message: 'Inconsistent batch progress.',
      });
  });
export type BatchStatus = z.infer<typeof batchStatusSchema>;
export const capabilitiesSchema = z.object({
  schemaVersion: z.literal(1),
  authenticated: z.literal(true),
  repeatImportBehavior: z.enum(['refresh-analysis']).optional(),
  pollingIntervalSeconds: z.number().min(30).max(3600),
  limits: z.object({
    maxItems: z.number().int().min(1).max(20),
    maxBodyBytes: z.number().min(1024).max(limits.maxBodyBytes),
    maxTextCharacters: z.number().min(1).max(limits.maxTextCharacters),
    maxTextBytes: z.number().min(1).max(limits.maxTextBytes),
  }),
});
export type Capabilities = z.infer<typeof capabilitiesSchema>;
