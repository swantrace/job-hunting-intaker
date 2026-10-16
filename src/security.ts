/** Only our top-level extension UI may ask the worker to use stored credentials. */
export function trustedSender(sender: chrome.runtime.MessageSender) {
  if (
    sender.id !== chrome.runtime.id ||
    !sender.url ||
    (sender.frameId ?? 0) !== 0
  )
    return false;
  return ['popup/index.html', 'options/index.html'].some((path) => {
    const allowed = chrome.runtime.getURL(path);
    return sender.url === allowed || sender.url?.startsWith(`${allowed}?`);
  });
}
