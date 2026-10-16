import { defaultPolicy } from '../contracts/intake';
import { ruleSchema, type SiteRule } from './schema';

// Editable starting templates, not a promise of compatibility with every layout.
const field = (selectors: string[]) => ({
  selectors,
  mode: 'text' as const,
  prefer: 'json-ld' as const,
});
const cssField = (selector: string) => ({
  selectors: [selector],
  mode: 'text' as const,
  prefer: 'css-selector' as const,
});
export const starterRules: SiteRule[] = [
  ruleSchema.parse({
    id: 'linkedin-detail',
    version: 1,
    label: 'LinkedIn detail (template)',
    enabled: true,
    hostnames: ['www.linkedin.com', 'linkedin.com'],
    pathPattern: '/jobs/view/*',
    rootSelectors: ['main'],
    excludeSelectors: ['aside', '.jobs-similar-jobs'],
    applicationSource: 'LinkedIn',
    fields: {
      rawText: field(['.jobs-description__content', '.description__text']),
      jobTitle: field(['h1']),
      companyName: field([
        '.job-details-jobs-unified-top-card__company-name',
        '.topcard__org-name-link',
      ]),
      location: field([
        '.job-details-jobs-unified-top-card__tertiary-description-container',
        '.topcard__flavor--bullet',
      ]),
    },
    identityPolicy: {
      ...defaultPolicy,
      dropQueryParams: ['trackingId', 'refId', 'trk'],
      fragmentMode: 'drop',
    },
  }),
  ruleSchema.parse({
    id: 'indeed-detail',
    version: 2,
    label: 'Indeed detail (template)',
    enabled: true,
    hostnames: [
      'www.indeed.com',
      'ca.indeed.com',
      'www.indeed.ca',
      'indeed.com',
    ],
    pathPattern: '/viewjob*',
    rootSelectors: ['#root'],
    applicationSource: 'Indeed',
    fields: {
      rawText: cssField('.simple-job-description-html'),
      jobTitle: cssField('[data-testid="vj-job-title"]'),
      companyName: cssField(
        '[data-testid="company-info-metadata"] a[href*="/cmp/"]',
      ),
      location: cssField(
        '[data-testid="structured-job-summary"] > div:nth-of-type(3)',
      ),
      salary: cssField(
        '[data-testid="structured-job-summary"] > div:nth-of-type(1)',
      ),
    },
    providerId: { type: 'query', name: 'jk' },
    identityPolicy: {
      version: 1,
      queryMode: 'keep-listed',
      queryParams: ['jk', 'vjk'],
      dropQueryParams: [],
      fragmentMode: 'drop',
    },
  }),
];
