import { browserHumanInputSchema, type BrowserHumanInput } from '@sazuz/core/browser';
import { currentPage, remember, type BrowserSession } from './session.js';

const keyCodes: Readonly<Record<string, number>> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Shift: 16,
  Control: 17,
  Alt: 18,
  Escape: 27,
  ' ': 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Insert: 45,
  Delete: 46,
  Meta: 91,
};

/** No event bodies are logged or retained. Only final field values enter the encrypted redactor. */
export async function humanInput(session: BrowserSession, input: BrowserHumanInput) {
  const message = browserHumanInputSchema.parse(input);
  const page = currentPage(session);
  if (
    (message.type === 'pointer' && message.event === 'mousePressed') ||
    (message.type === 'key' &&
      message.event === 'keyDown' &&
      ['Enter', 'Tab'].includes(message.key))
  ) {
    const values = await page.locator('input,textarea').evaluateAll((nodes) =>
      nodes
        .filter((node) => !['checkbox', 'radio'].includes((node as HTMLInputElement).type))
        .map((node) => (node as HTMLInputElement).value)
        .filter(Boolean)
        .slice(0, 100),
    );
    for (const value of values) remember(session, value);
  }
  if (!session.cdp || session.cdpPage !== page) {
    await session.cdp?.detach();
    session.cdp = await session.context.newCDPSession(page);
    session.cdpPage = page;
  }
  if (message.type === 'text') {
    remember(session, message.text);
    await session.cdp.send('Input.insertText', { text: message.text });
  } else if (message.type === 'key') {
    const keyCode =
      keyCodes[message.key] ??
      (/^[a-z0-9]$/i.test(message.key) ? message.key.toUpperCase().charCodeAt(0) : 0);
    const text =
      message.key === 'Enter' ? '\r' : message.key.length === 1 ? message.key : undefined;
    await session.cdp.send('Input.dispatchKeyEvent', {
      type: message.event,
      key: message.key,
      code: message.code,
      modifiers: message.modifiers,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      ...(message.event === 'keyDown' && (message.modifiers & ~8) === 0 && text ? { text } : {}),
    });
  } else {
    await session.cdp.send('Input.dispatchMouseEvent', {
      type: message.event,
      x: message.x,
      y: message.y,
      button: message.button,
      clickCount: message.event === 'mousePressed' || message.event === 'mouseReleased' ? 1 : 0,
      ...(message.event === 'mouseWheel' ? { deltaX: 0, deltaY: message.deltaY } : {}),
    });
  }
}
