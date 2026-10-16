import { hostPermission } from '../api/client';
import { matchRule, type SiteRule } from '../rules/schema';
import { type Extraction, extractFromPage } from './page';
import { withExtractionTimeout } from './timeout';

export async function extractTab(
  requestedTabId: number,
  rule: SiteRule,
  expectedUrl?: string,
  expectedGroupId?: number,
): Promise<Extraction> {
  let tabId = requestedTabId;
  const diagnostics: Record<string, string> = {
    tabId: String(tabId),
    rule: `${rule.id} v${rule.version}`,
    stage: 'Reading tab details',
    ...(expectedUrl ? { url: expectedUrl } : {}),
  };
  let originalTabId: number | undefined;
  let windowId: number | undefined;
  let activated = false;
  let finished = false;
  const readTab = async () => {
    try {
      return await chrome.tabs.get(tabId);
    } catch (error) {
      if (!expectedUrl || expectedGroupId === undefined || finished)
        throw error;
      const matches = (
        await chrome.tabs.query({ groupId: expectedGroupId })
      ).filter((tab) => tab.url === expectedUrl);
      const replacement = matches.length === 1 ? matches[0] : undefined;
      if (replacement?.id === undefined) throw error;
      diagnostics.replacedTabId = String(tabId);
      tabId = replacement.id;
      diagnostics.tabId = String(tabId);
      return replacement;
    }
  };
  const restoreOriginalTab = async () => {
    if (!activated || originalTabId === undefined || originalTabId === tabId)
      return;
    const [current] = await chrome.tabs.query({ active: true, windowId });
    // Respect a user who switched away while capture was running.
    if (current?.id === tabId)
      await chrome.tabs.update(originalTabId, { active: true });
  };
  try {
    return await withExtractionTimeout(
      async () => {
        const tab = await readTab();
        diagnostics.url = tab.url ?? '(unavailable)';
        diagnostics.tabStatus = tab.status ?? 'unknown';
        diagnostics.discarded = String(tab.discarded ?? false);
        diagnostics.frozen = String('frozen' in tab ? tab.frozen : 'unknown');
        if (!tab.url)
          throw new Error(
            'Tab URL is unavailable. Refresh the group list and capture again.',
          );
        if (expectedGroupId !== undefined && tab.groupId !== expectedGroupId)
          throw new Error('Tab is no longer in the chosen group.');
        if (expectedUrl && tab.url !== expectedUrl)
          throw new Error(
            'Tab navigated after selection. Capture the group again.',
          );
        diagnostics.stage = 'Matching website rule';
        matchRule([rule], tab.url, rule.id);
        diagnostics.stage = 'Checking website permission';
        const permission = hostPermission(tab.url);
        diagnostics.requiredPermission = permission;
        if (!(await chrome.permissions.contains({ origins: [permission] })))
          throw new Error(
            `Website permission is missing for ${new URL(tab.url).hostname}. Save the rule and grant website access in Settings.`,
          );
        if (tab.discarded || ('frozen' in tab && tab.frozen === true)) {
          diagnostics.stage = tab.discarded
            ? 'Reloading discarded tab by activation'
            : 'Waking frozen tab';
          windowId = tab.windowId;
          const [original] = await chrome.tabs.query({
            active: true,
            windowId,
          });
          if (finished) throw new Error('Capture already timed out.');
          originalTabId = original?.id;
          activated = true;
          await chrome.tabs.update(tabId, { active: true });
          if (finished) {
            await restoreOriginalTab();
            throw new Error('Capture already timed out.');
          }
          let awake = await readTab();
          while (
            awake.discarded ||
            ('frozen' in awake && awake.frozen === true) ||
            awake.status === 'loading'
          ) {
            if (finished) throw new Error('Capture already timed out.');
            diagnostics.tabStatus = awake.status ?? 'unknown';
            diagnostics.discarded = String(awake.discarded ?? false);
            diagnostics.frozen = String(
              'frozen' in awake ? awake.frozen : 'unknown',
            );
            await new Promise((resolve) => setTimeout(resolve, 100));
            awake = await readTab();
          }
          if (finished) throw new Error('Capture already timed out.');
          if (awake.url !== tab.url)
            throw new Error(
              'Page changed while waking the tab. Capture again.',
            );
          diagnostics.frozen = 'false';
          diagnostics.discarded = 'false';
          diagnostics.tabStatus = awake.status ?? 'unknown';
          diagnostics.wakeAction = tab.discarded
            ? 'Activated discarded tab and waited for reload'
            : 'Activated frozen tab before extraction';
        }
        diagnostics.stage = 'Probing page script execution';
        const probe = await chrome.scripting.executeScript({
          target: { tabId, frameIds: [0] },
          world: 'ISOLATED',
          injectImmediately: true,
          func: () => ({ url: location.href, readyState: document.readyState }),
        });
        if (!probe[0]?.result)
          throw new Error(
            'The page probe returned no result. Open the tab and retry.',
          );
        diagnostics.documentState = probe[0].result.readyState;
        if (probe[0].result.url !== tab.url)
          throw new Error(
            'Page redirected during capture. Capture again using its current URL.',
          );
        diagnostics.stage = 'Waiting for page extraction result';
        const result = await chrome.scripting.executeScript({
          target: { tabId, frameIds: [0] },
          world: 'ISOLATED',
          injectImmediately: true,
          func: extractFromPage,
          args: [rule],
        });
        const value = result[0]?.result;
        if (!value)
          throw new Error(
            'The extraction script returned no result. Open the tab and retry.',
          );
        diagnostics.stage = 'Checking page identity after extraction';
        const after = await readTab();
        if (
          after.url !== tab.url ||
          (value.item && value.item.sourceUrl !== tab.url)
        )
          throw new Error('Page changed during capture. Capture again.');
        return {
          ...value,
          ...(value.error
            ? { error: `${value.error} [${tab.url}; rule ${rule.id}]` }
            : {}),
          diagnostics: { ...diagnostics, ...value.diagnostics },
        };
      },
      () =>
        `Stage: ${diagnostics.stage}. Tab ${tabId}; URL: ${diagnostics.url}; rule: ${diagnostics.rule}. Chrome has not returned a result; the exact in-page cause is not yet known.`,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Page capture failed.';
    return {
      error: `${message} [Stage: ${diagnostics.stage}; tab ${tabId}; URL: ${diagnostics.url}; rule: ${diagnostics.rule}]`,
      warnings: [],
      diagnostics,
    };
  } finally {
    finished = true;
    // Tab closure or a failed restore must not discard the extracted job.
    await withExtractionTimeout(
      restoreOriginalTab,
      () => 'Restoring the original active tab.',
      1000,
    ).catch(() => undefined);
  }
}
