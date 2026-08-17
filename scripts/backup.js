import fs from 'node:fs';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../packages/core/config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = loadConfig(root);
const destinationDirectory = path.resolve(root, process.argv[2] ?? './backups');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const destination = path.join(destinationDirectory, `xiuxian-${stamp}.sqlite`);

if (!fs.existsSync(config.databasePath)) throw new Error(`Database does not exist: ${config.databasePath}`);
fs.mkdirSync(destinationDirectory, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(config.databasePath, { readOnly: true });
try {
  await backup(db, destination);
  fs.chmodSync(destination, 0o600);
  const stats = fs.statSync(destination);
  console.log(JSON.stringify({ backedUp: true, destination, bytes: stats.size }));
} finally {
  db.close();
}
