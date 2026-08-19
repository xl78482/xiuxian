import {
  bindMiniAppCssVars,
  bindThemeParamsCssVars,
  bindViewportCssVars,
  disableVerticalSwipes,
  expandViewport,
  hideBackButton,
  init,
  isFullscreen,
  miniAppReady,
  mountBackButton,
  mountMiniAppSync,
  mountSwipeBehavior,
  mountThemeParamsSync,
  mountViewport,
  requestFullscreen,
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
  setupFullscreen();
}

// Telegram 官方限制 requestFullscreen 必须由用户手势触发，无法"打开即全屏"。
// 在 pointerdown（手指按下瞬间）即请求全屏，用户"一碰屏幕就进全屏"；
// click 监听作为键盘/无障碍操作兜底。旧客户端 / 网页版自动降级为 expand 现状。
function setupFullscreen(): void {
  const fn = requestFullscreen as unknown as {
    isAvailable: () => boolean;
    (options?: unknown): Promise<void> | undefined;
  };
  if (typeof fn !== 'function' || !fn.isAvailable()) return;
  let requested = false;
  const tryEnterFullscreen = () => {
    if (requested) return;
    requested = true;
    document.removeEventListener('pointerdown', tryEnterFullscreen);
    document.removeEventListener('click', tryEnterFullscreen);
    try {
      if (!isFullscreen()) {
        const result = fn();
        // 部分客户端返回 Promise，部分同步完成；失败静默忽略，保持当前状态
        if (result && typeof result.catch === 'function') result.catch(() => {});
      }
    } catch {
      // 用户取消或环境不支持时保持当前状态
    }
  };
  document.addEventListener('pointerdown', tryEnterFullscreen, { once: true });
  document.addEventListener('click', tryEnterFullscreen, { once: true });
}
