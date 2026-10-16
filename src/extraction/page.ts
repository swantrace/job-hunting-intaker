import type { CaptureItem, Field } from '../contracts/intake';
import type { SiteRule } from '../rules/schema';

export type Extraction = {
  item?: Omit<CaptureItem, 'clientItemId'>;
  error?: string;
  warnings: string[];
  diagnostics?: Record<string, string>;
};

/** Serialized by chrome.scripting: everything used at runtime lives inside this function. */
export async function extractFromPage(rule: SiteRule): Promise<Extraction> {
  const warnings: string[] = [];
  const diagnostics: Record<string, string> = {
    stage: 'Starting page extraction',
    url: location.href,
    documentState: document.readyState,
  };
  const startUrl = location.href;
  try {
    if (
      !['https:', 'http:'].includes(location.protocol) ||
      window !== window.top
    )
      throw new Error('Only accessible top-frame job pages are supported.');
    const choose = (selectors: string[], root: ParentNode) => {
      for (const selector of selectors) {
        let nodes: NodeListOf<Element>;
        try {
          nodes = root.querySelectorAll(selector);
        } catch {
          throw new Error(`Invalid CSS selector: ${selector}`);
        }
        if (nodes.length > 1)
          throw new Error(
            `Ambiguous selector (${nodes.length} matches): ${selector}`,
          );
        if (nodes.length === 1) return { node: nodes[0], selector };
      }
      return null;
    };
    const idFromPage = () => {
      const id = rule.providerId;
      if (id?.type === 'query')
        return new URL(location.href).searchParams.get(id.name);
      if (id?.type === 'path')
        return (
          new URL(location.href).pathname.split('/').filter(Boolean)[
            id.segment
          ] ?? null
        );
      if (id?.type === 'attribute')
        return (
          choose([id.selector], document)?.node.getAttribute(id.attribute) ??
          null
        );
      return (
        new URL(location.href).searchParams.get('currentJobId') ??
        new URL(location.href).searchParams.get('jk') ??
        new URL(location.href).searchParams.get('vjk') ??
        location.pathname.match(/\/jobs\/view\/(?:[^/]*-)?(\d+)\/?$/)?.[1] ??
        null
      );
    };
    const startId = idFromPage();
    diagnostics.stage = 'Waiting for root and job description';
    diagnostics.rootSelectors = rule.rootSelectors.join('; ');
    diagnostics.descriptionSelectors = rule.fields.rawText.selectors.join('; ');
    const deadline = Date.now() + 10000;
    let root = choose(rule.rootSelectors, document);
    const hasBody = () => {
      const current = root;
      return (
        !!current &&
        (rule.fields.rawText.selectors.some(
          (selector) =>
            !!choose([selector], current.node)?.node.textContent?.trim(),
        ) ||
          [
            ...document.querySelectorAll('script[type="application/ld+json"]'),
          ].some((script) => script.textContent?.includes('JobPosting')))
      );
    };
    while ((!root || !hasBody()) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (location.href !== startUrl || (startId && idFromPage() !== startId))
        throw new Error(
          'The selected job changed during capture. Capture again.',
        );
      root = choose(rule.rootSelectors, document);
    }
    if (!root)
      throw new Error(
        `No job root found within 10 seconds. Tried: ${rule.rootSelectors.join('; ')}. Document state: ${document.readyState}. Load/expand the job, or edit the rule. Iframes/shadow roots are not traversed.`,
      );
    diagnostics.root = root.selector;
    diagnostics.stage = 'Reading structured job data';
    const cleanHtml = (html: string) => {
      const template = document.createElement('template');
      template.innerHTML = html
        .replace(/<\/(?:p|div|section|article|h[1-6]|ul|ol)>/gi, '$&\n\n')
        .replace(/<li\b[^>]*>/gi, '\n• ')
        .replace(/<br\s*\/?\s*>/gi, '\n');
      for (const node of template.content.querySelectorAll(
        'script,style,nav,header,footer,aside,iframe',
      ))
        node.remove();
      for (const selector of rule.excludeSelectors)
        for (const node of template.content.querySelectorAll(selector))
          node.remove();
      return (template.content.textContent ?? '')
        .replace(/[\t \u00a0]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    };
    type Json = Record<string, unknown>;
    const postings: Json[] = [];
    let visited = 0;
    const walk = (value: unknown, depth = 0) => {
      if (depth > 15 || ++visited > 2000) return;
      if (Array.isArray(value)) {
        for (const entry of value) walk(entry, depth + 1);
        return;
      }
      if (!value || typeof value !== 'object') return;
      const object = value as Json;
      const type = object['@type'];
      if (
        type === 'JobPosting' ||
        (Array.isArray(type) && type.includes('JobPosting'))
      )
        postings.push(object);
      if (object['@graph']) walk(object['@graph'], depth + 1);
    };
    for (const script of [
      ...document.querySelectorAll('script[type="application/ld+json"]'),
    ].slice(0, 20)) {
      if ((script.textContent?.length ?? 0) > 500000) continue;
      try {
        walk(JSON.parse(script.textContent ?? ''));
      } catch {
        warnings.push('Invalid JSON-LD ignored.');
      }
    }
    const providerId = idFromPage();
    const comparable = (value: string) => {
      const url = new URL(value, startUrl);
      for (const key of [...new Set(url.searchParams.keys())])
        if (
          rule.identityPolicy.dropQueryParams.includes(key) ||
          (rule.identityPolicy.queryMode === 'keep-listed' &&
            !rule.identityPolicy.queryParams.includes(key))
        )
          url.searchParams.delete(key);
      if (rule.identityPolicy.fragmentMode === 'drop') url.hash = '';
      return url.href;
    };
    const matching = postings.filter((post) => {
      const urls = [post.url, post['@id']].filter(
        (v): v is string => typeof v === 'string',
      );
      const identifier = post.identifier;
      const id =
        identifier && typeof identifier === 'object'
          ? String((identifier as Json).value ?? '')
          : typeof identifier === 'string'
            ? identifier
            : '';
      return (
        (providerId && id === providerId) ||
        urls.some((value) => {
          try {
            return comparable(value) === comparable(startUrl);
          } catch {
            return false;
          }
        })
      );
    });
    const sole = postings.length === 1 ? postings[0] : undefined;
    const soleIdentity = sole?.identifier;
    const explicitSoleIdentity =
      sole &&
      (typeof sole.url === 'string' ||
        typeof sole['@id'] === 'string' ||
        (providerId && soleIdentity));
    const structured =
      matching.length === 1
        ? matching[0]
        : sole && !explicitSoleIdentity
          ? sole
          : undefined;
    if (sole && !structured)
      warnings.push(
        'Unrelated JSON-LD ignored: it does not identify this page’s job.',
      );
    if (postings.length > 1 && !structured)
      warnings.push(
        'Ambiguous JSON-LD jobs ignored; only the selected DOM root is used.',
      );
    const object = (value: unknown): Json =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Json)
        : {};
    const str = (value: unknown) =>
      typeof value === 'string' ? value.trim() : '';
    const locationObject = object(
      Array.isArray(structured?.jobLocation)
        ? structured.jobLocation[0]
        : structured?.jobLocation,
    );
    const address = object(locationObject.address);
    const salary = object(structured?.baseSalary);
    const salaryValue = object(salary.value);
    const salaryAmount =
      salaryValue.value ??
      (salaryValue.minValue != null && salaryValue.maxValue != null
        ? `${salaryValue.minValue}–${salaryValue.maxValue}`
        : '');
    const jsonValues: Record<string, string> = {
      rawText: str(structured?.description)
        ? cleanHtml(str(structured?.description))
        : '',
      jobTitle: str(structured?.title),
      companyName: str(object(structured?.hiringOrganization).name),
      location:
        [address.addressLocality, address.addressRegion, address.addressCountry]
          .map(str)
          .filter(Boolean)
          .join(', ') ||
        (structured?.jobLocationType === 'TELECOMMUTE' ? 'Remote' : ''),
      postedDate: str(structured?.datePosted),
      salary: salaryAmount
        ? [salary.currency, salaryAmount, salaryValue.unitText]
            .filter(Boolean)
            .join(' ')
        : '',
    };
    const fieldSources: Partial<Record<Field, 'json-ld' | 'css-selector'>> = {};
    const adopted: Record<string, string | null> = {};
    for (const name of [
      'rawText',
      'jobTitle',
      'companyName',
      'location',
      'postedDate',
      'salary',
    ] as const) {
      diagnostics.stage = `Extracting field: ${name}`;
      const config = rule.fields[name];
      let css = '';
      for (const selector of config?.selectors ?? []) {
        const found = choose([selector], root.node);
        if (!found || !config) continue;
        css =
          config.mode === 'attribute'
            ? (found.node.getAttribute(config.attribute ?? 'content') ?? '')
            : name === 'rawText'
              ? cleanHtml(found.node.innerHTML)
              : config.mode === 'innerText'
                ? (found.node as HTMLElement).innerText
                : (found.node.textContent ?? '');
        css = css.trim();
        diagnostics[name] = `${found.selector} (${config.mode})`;
        if (css) break;
      }
      const useJson =
        !!jsonValues[name] && (config?.prefer !== 'css-selector' || !css);
      adopted[name] = (useJson ? jsonValues[name] : css) || null;
      if (name !== 'rawText' && adopted[name])
        fieldSources[name] = useJson ? 'json-ld' : 'css-selector';
    }
    const rawText = adopted.rawText;
    diagnostics.stage = 'Validating job description';
    if (!rawText)
      throw new Error(
        `No job description found under ${root.selector}. Tried: ${rule.fields.rawText.selectors.join('; ')}. No usable JSON-LD description. Edit the rule or paste the text manually.`,
      );
    if (
      rawText.length > 60000 ||
      new TextEncoder().encode(rawText).length > 131072
    )
      throw new Error(
        'Job text exceeds API limits. Refine the description/root selector.',
      );
    if (
      /^\s*(?:access denied\b|captcha\b|sign in to continue\b)/i.test(rawText)
    )
      throw new Error(
        'The page is blocked or requires sign-in. No capture submitted.',
      );
    if (rawText.length < 200)
      warnings.push(
        'Short description: check that the full job post is expanded.',
      );
    if (
      /show more|read more|see more|show full/i.test(
        root.node.textContent ?? '',
      )
    )
      warnings.push(
        'The page may be truncated. Expand the full description before importing.',
      );
    const dateText = adopted.postedDate;
    let postedDate: string | null = null;
    if (dateText && /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(dateText)) {
      const day = dateText.slice(0, 10);
      if (
        Number.isFinite(Date.parse(day)) &&
        new Date(day).toISOString().slice(0, 10) === day
      )
        postedDate = day;
    }
    if (dateText && !postedDate) {
      diagnostics.postedDateRaw = dateText;
      warnings.push('Uncertain posted date left unknown.');
    }
    if (
      location.href !== startUrl ||
      idFromPage() !== providerId ||
      (startId && startId !== providerId)
    )
      throw new Error(
        'The selected job changed during capture. Capture again.',
      );
    const metadata = Object.fromEntries(
      ['jobTitle', 'companyName', 'location', 'salary'].map((name) => [
        name,
        adopted[name],
      ]),
    );
    return {
      item: {
        sourceUrl: startUrl,
        rawText,
        applicationSource: rule.applicationSource || null,
        suggestedMetadata: { ...metadata, postedDate },
        capture: {
          capturedAt: new Date().toISOString(),
          ruleId: rule.id,
          ruleVersion: String(rule.version),
          fieldSources,
        },
        identity: {
          ...(providerId && /^[\w.-]{1,200}$/.test(providerId)
            ? { providerJobId: providerId }
            : {}),
          policy: rule.identityPolicy,
        },
      },
      warnings,
      diagnostics,
    };
  } catch (error) {
    return {
      error: `${error instanceof Error ? error.message : 'Page extraction failed.'} [Stage: ${diagnostics.stage}]`,
      warnings,
      diagnostics,
    };
  }
}
