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
  off,
  on,
  offBackButtonClick,
  onBackButtonClick,
  requestFullscreen,
  setMiniAppBackgroundColor,
  setMiniAppHeaderColor,
  showBackButton,
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
  // 1. ready()：通知 Telegram 页面已加载完成，可安全展示内容。
  callSafe(miniAppReady);
  // 2. ready 后延迟 300ms 再 expand()，避免在 Telegram 尚未就绪时过早请求展开被忽略，
  //    导致 Mini App 停留在 Bottom Sheet 半屏状态。
  window.setTimeout(() => {
    callSafe(expandViewport);
  }, 300);
  // 3. 监听 viewportChanged：视口变化（如用户手动下拉、键盘弹出、全屏切换）时再次 expand，
  //    确保 Mini App 始终展开到最大可用高度；失败静默忽略，不阻断页面。
  const onViewportChanged = () => {
    callSafe(expandViewport);
  };
  callSafe(on, 'viewport_changed', onViewportChanged);
  // 4. 以下能力均不阻塞展开流程。
  callSafe(disableVerticalSwipes);
  callSafe(hideBackButton);
  // 5. fullscreen 逻辑独立于 expand：仅监听用户首次手势触发，不干扰展开。
  setupFullscreen();
}

/** 按路由状态同步 Telegram 原生 BackButton 的显隐。 */
export function setTelegramBackButton(visible: boolean): void {
  callSafe(visible ? showBackButton : hideBackButton);
}

/** 绑定 Telegram 原生 BackButton 点击事件；返回解除函数。 */
export function bindTelegramBackButton(onBack: () => void): () => void {
  const off = callSafe(onBackButtonClick, onBack);
  return () => {
    if (typeof off === 'function') off();
    callSafe(offBackButtonClick, onBack);
  };
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
