import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRuntime } from '../packages/core/runtime.js';
import { seedDemoData } from '../packages/core/demo.js';
import { one } from '../packages/core/database.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = createRuntime(root);
seedDemoData(runtime);
console.log(JSON.stringify({
  seeded: true,
  products: Number(one(runtime.db, 'SELECT COUNT(*) AS total FROM products').total),
  cards: Number(one(runtime.db, 'SELECT COUNT(*) AS total FROM card_credentials').total),
}));
runtime.db.close();
