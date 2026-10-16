import { change } from './state';

/** Close only the page represented by a stored preview, never a caller-supplied tab ID. */
export function closePreviewTab(previewId: string) {
  return change(async (state) => {
    if (state.capture)
      throw new Error('Wait for capture to finish before closing tabs.');
    const preview = state.previews.find((row) => row.id === previewId);
    if (!preview) throw new Error('Preview not found.');
    if (preview.tabClosed) return;
    const id = Number(preview.diagnostics?.tabId ?? preview.tabId);
    let tab = await chrome.tabs.get(id).catch(() => undefined);
    if (tab && tab.url !== preview.url)
      throw new Error(
        'This tab has navigated to another page. It was not closed.',
      );
    if (!tab) {
      const matches = (
        await chrome.tabs.query({ groupId: preview.groupId })
      ).filter((row) => row.url === preview.url);
      if (matches.length > 1)
        throw new Error(
          'Multiple tabs match this URL. Close the intended tab manually.',
        );
      tab = matches[0];
    }
    if (tab?.id !== undefined) await chrome.tabs.remove(tab.id);
    preview.tabClosed = true;
  });
}
