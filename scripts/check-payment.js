import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../packages/core/runtime.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = createRuntime(root);
try {
  if (runtime.paymentProvider.name !== 'dujiaopay' || typeof runtime.paymentProvider.whoAmI !== 'function') {
    throw new Error('PAYMENT_PROVIDER must be dujiaopay for the credential check.');
  }
  const identity = await runtime.paymentProvider.whoAmI();
  console.log(JSON.stringify({ ok: true, provider: runtime.paymentProvider.name, ...identity }));
} finally {
  runtime.db.close();
}
