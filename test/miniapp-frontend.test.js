import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const telegram = fs.readFileSync(path.join(root, 'apps/miniapp/src/telegram.ts'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'apps/miniapp/src/styles.css'), 'utf8');
const app = fs.readFileSync(path.join(root, 'apps/miniapp/src/App.tsx'), 'utf8');
const api = fs.readFileSync(path.join(root, 'apps/miniapp/src/api.ts'), 'utf8');

test('uses the official Telegram lifecycle without fullscreen requests', () => {
  assert.match(telegram, /useRawInitData|@telegram-mini-apps\/sdk-react/);
  assert.match(telegram, /miniAppReady/);
  assert.match(telegram, /expandViewport/);
  assert.match(telegram, /disableVerticalSwipes/);
  assert.match(telegram, /hideBackButton/);
  assert.ok(telegram.indexOf('callSafe(miniAppReady)') < telegram.indexOf('callSafe(expandViewport)'));
  assert.doesNotMatch(telegram, /requestFullscreen|exitFullscreen/);
});

test('uses dynamic viewport and safe-area layout instead of 100vh', () => {
  assert.doesNotMatch(styles, /100vh/);
  assert.match(styles, /100dvh/);
  assert.match(styles, /--tg-viewport-safe-area-inset-bottom/);
  assert.match(styles, /env\(safe-area-inset-bottom/);
  assert.match(styles, /\.bottom-nav/);
});

test('authorizes with raw Telegram init data and preserves order filters', () => {
  assert.match(app, /useRawInitData/);
  assert.match(api, /Authorization.*tma/);
  assert.match(api, /X-Telegram-Init-Data/);
  assert.match(app, /ORDER_GROUPS/);
  assert.match(app, /order-filters/);
});
