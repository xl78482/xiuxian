import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRuntime } from '../../packages/core/runtime.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runtime = createRuntime(root);
let stopping = false;

async function tick() {
  if (stopping) return;
  try {
    const fulfilled = runtime.commerce.processJobs(20);
    const reconciled = await runtime.commerce.reconcileDuePayments(30);
    if (fulfilled || reconciled) console.info(JSON.stringify({ fulfilled, reconciled }));
  } catch (error) {
    console.error(error instanceof Error ? error.stack : error);
  }
}

const timer = setInterval(() => void tick(), 3000);
void tick();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    stopping = true;
    clearInterval(timer);
    runtime.db.close();
    process.exit(0);
  });
}
