import { defaultPolicy } from '../contracts/intake';
import { ruleSchema, type SiteRule } from './schema';

// Editable starting templates, not a promise of compatibility with every layout.
const field = (selectors: string[]) => ({
  selectors,
  mode: 'text' as const,
  prefer: 'json-ld' as const,
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
    version: 1,
    label: 'Indeed detail (template)',
    enabled: true,
    hostnames: [
      'www.indeed.com',
      'ca.indeed.com',
      'www.indeed.ca',
      'indeed.com',
    ],
    pathPattern: '/viewjob*',
    rootSelectors: ['#viewJobSSRRoot', 'main'],
    applicationSource: 'Indeed',
    fields: {
      rawText: field(['#jobDescriptionText']),
      jobTitle: field(['h1']),
      companyName: field(['[data-testid="inlineHeader-companyName"]']),
      location: field(['[data-testid="inlineHeader-companyLocation"]']),
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
