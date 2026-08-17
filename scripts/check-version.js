import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageMetadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = packageMetadata.version;

if (typeof version !== 'string' || !/^1\.0\.\d+$/.test(version)) {
  throw new Error('package.json version must use the strict 1.0.N format.');
}

const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
if (!readme.includes(`当前版本：\`${version}\``)) {
  throw new Error(`README.md current version must be ${version}.`);
}

for (const entry of ['apps/miniapp/index.html', 'apps/admin/index.html']) {
  const html = fs.readFileSync(path.join(root, entry), 'utf8');
  const resourceVersions = [...html.matchAll(/[?&]v=([0-9]+\.[0-9]+\.[0-9]+)/g)].map((match) => match[1]);
  if (resourceVersions.length < 2 || resourceVersions.some((value) => value !== version)) {
    throw new Error(`${entry} asset versions must all be ${version}.`);
  }
}

const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
if (!dockerfile.includes(`org.opencontainers.image.version=\"${version}\"`)) {
  throw new Error(`Dockerfile image version must be ${version}.`);
}

const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
const heading = `## [${version}] - `;
if (!changelog.includes(heading)) {
  throw new Error(`CHANGELOG.md must contain a ${version} release heading.`);
}

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

let latestTag = null;
try {
  latestTag = git(['describe', '--tags', '--abbrev=0', '--match', 'v1.0.*']);
} catch {
  // The first release has no existing version tag.
}

const currentTag = `v${version}`;
let expectedNext = 'v1.0.0';
if (latestTag) {
  const latestPatch = Number(latestTag.split('.')[2]);
  expectedNext = `v1.0.${latestPatch + 1}`;
  if (latestTag === currentTag) {
    try {
      execFileSync('git', ['diff', '--quiet', latestTag, '--', '.'], { cwd: root, stdio: 'ignore' });
    } catch {
      throw new Error(`Tracked files changed after ${latestTag}; the next version must be ${expectedNext}.`);
    }
  } else if (currentTag !== expectedNext) {
    throw new Error(`Version must advance exactly one step: expected ${expectedNext}, received ${currentTag}.`);
  }
} else if (currentTag !== expectedNext) {
  throw new Error(`The first release must be ${expectedNext}.`);
}

console.log(JSON.stringify({ version, changelog: true, readme: true, latestTag, expectedNext }));
