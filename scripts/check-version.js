import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageMetadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = packageMetadata.version;

if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error('package.json version must use MAJOR.MINOR.PATCH format.');
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

function numericVersion(value) {
  return value.replace(/^v/, '').split('.').map(Number);
}

function compareVersions(left, right) {
  const a = numericVersion(left);
  const b = numericVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

let latestTag = null;
try {
  latestTag = git(['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*']);
} catch {
  // The first release has no existing version tag.
}

const currentTag = `v${version}`;
if (latestTag && latestTag !== currentTag && compareVersions(currentTag, latestTag) <= 0) {
  throw new Error(`Version ${version} must be newer than latest release ${latestTag}.`);
}
if (latestTag === currentTag) {
  try {
    execFileSync('git', ['diff', '--quiet', latestTag, '--', '.'], { cwd: root, stdio: 'ignore' });
  } catch {
    throw new Error(`Tracked files changed after ${latestTag}; increase the version before pushing.`);
  }
}

console.log(JSON.stringify({ version, changelog: true, readme: true, latestTag }));
