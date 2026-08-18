import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRuntime } from '../../packages/core/runtime.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runtime = createRuntime(root);
let stopping = false;
let ticking = false;

async function tick() {
  if (stopping || ticking) return;
  ticking = true;
  try {
    runtime.reloadPaymentConfig();
    const recovered = runtime.commerce.recoverStaleFulfillmentJobs();
    const fulfilled = runtime.commerce.processJobs(20);
    const reconciled = await runtime.commerce.reconcileDuePayments(30);
    if (recovered || fulfilled || reconciled) console.info(JSON.stringify({ recovered, fulfilled, reconciled }));
  } catch (error) {
    console.error(error instanceof Error ? error.stack : error);
  } finally {
    ticking = false;
  }
}

const timer = setInterval(() => void tick(), 3000);
void tick();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    stopping = true;
    clearInterval(timer);
    const deadline = Date.now() + 15_000;
    while (ticking && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    runtime.db.close();
    process.exit(ticking ? 1 : 0);
  });
}
