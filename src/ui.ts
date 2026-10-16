import type { publicState } from './storage/state';
export type PublicState = ReturnType<typeof publicState>;
export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = '',
  className = '',
) {
  const node = document.createElement(tag);
  node.textContent = text;
  node.className = className;
  return node;
}
export const get = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
export async function send<T = unknown>(message: unknown): Promise<T> {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok)
    throw new Error(
      response?.error ??
        'Extension worker did not respond. Reload the extension.',
    );
  return response.data;
}
export function report(error: unknown) {
  const node = get('feedback');
  node.textContent = error instanceof Error ? error.message : String(error);
  node.hidden = false;
}
export function action(
  text: string,
  run: () => unknown | Promise<unknown>,
  className = 'btn btn-sm',
) {
  const button = element('button', text, className);
  button.type = 'button';
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await run();
    } catch (error) {
      report(error);
    } finally {
      button.disabled = false;
    }
  });
  return button;
}
export function inputField(
  label: string,
  name: string,
  value = '',
  type = 'text',
) {
  const field = element('fieldset', '', 'fieldset');
  const id = `field-${crypto.randomUUID()}`;
  const caption = element('label', label, 'label');
  caption.htmlFor = id;
  const input = element('input', '', 'input w-full');
  input.type = type;
  input.name = name;
  input.id = id;
  input.value = value;
  field.append(caption, input);
  return field;
}
