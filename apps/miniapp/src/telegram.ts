import {
  bindMiniAppCssVars,
  bindThemeParamsCssVars,
  bindViewportCssVars,
  disableVerticalSwipes,
  expandViewport,
  hideBackButton,
  init,
  miniAppReady,
  mountBackButton,
  mountMiniAppSync,
  mountSwipeBehavior,
  mountThemeParamsSync,
  mountViewport,
  setMiniAppBackgroundColor,
  setMiniAppHeaderColor,
} from '@telegram-mini-apps/sdk-react';

let initialized = false;

type SafeFunction = ((...values: unknown[]) => unknown) & { isAvailable?: () => boolean };

function callSafe(fn: unknown, ...args: unknown[]) {
  if (typeof fn !== 'function') return undefined;
  try {
    const wrapped = fn as SafeFunction;
    if (wrapped.isAvailable && !wrapped.isAvailable()) return undefined;
    return wrapped(...args);
  } catch {
    return undefined;
  }
}

export async function setupTelegram(): Promise<void> {
  if (!initialized) {
    try {
      init();
      initialized = true;
    } catch {
      // Normal browser previews can render without Telegram's host bridge.
    }
  }

  callSafe(mountMiniAppSync);
  callSafe(mountThemeParamsSync);
  callSafe(bindMiniAppCssVars);
  callSafe(bindThemeParamsCssVars);

  try {
    await callSafe(mountViewport);
  } catch {
    // Older Telegram clients may not expose viewport mounting.
  }
  callSafe(bindViewportCssVars);
  callSafe(mountSwipeBehavior);
  callSafe(mountBackButton);
  callSafe(setMiniAppHeaderColor, '#f3f5fb');
  callSafe(setMiniAppBackgroundColor, '#f3f5fb');
}

export function presentTelegram(): void {
  // Telegram contract: render essential UI, call ready(), then expand() to maximum available height.
  callSafe(miniAppReady);
  callSafe(expandViewport);
  callSafe(disableVerticalSwipes);
  callSafe(hideBackButton);
}
