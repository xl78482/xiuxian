import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appRoot = path.join(root, 'apps', 'miniapp');
const sourceIndex = path.join(appRoot, 'index.html');
const sourceCss = path.join(appRoot, 'src', 'styles.css');
const outDir = path.join(appRoot, 'dist');
const assetsDir = path.join(outDir, 'assets');
const packageMetadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = packageMetadata.version;

if (!process.env.ESBUILD_BINARY_PATH && process.platform === 'linux' && process.arch === 'arm64') {
  const installedBinary = path.join(root, 'node_modules', '@esbuild', 'linux-arm64', 'bin', 'esbuild');
  const probe = fs.existsSync(installedBinary) ? spawnSync(installedBinary, ['--version']) : null;
  if (!probe || probe.error) {
    if (fs.existsSync(installedBinary)) {
      const executable = path.join(os.tmpdir(), `xiuxian-esbuild-${process.pid}`);
      fs.copyFileSync(installedBinary, executable);
      fs.chmodSync(executable, 0o755);
      process.env.ESBUILD_BINARY_PATH = executable;
    }
  }
}

const { build } = await import('esbuild');

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(assetsDir, { recursive: true });

await build({
  entryPoints: [path.join(appRoot, 'src', 'main.tsx')],
  outfile: path.join(assetsDir, 'app.js'),
  bundle: true,
  format: 'esm',
  target: 'es2020',
  minify: true,
  sourcemap: false,
  jsx: 'automatic',
  loader: { '.ts': 'ts', '.tsx': 'tsx' },
});

const css = fs.readFileSync(sourceCss, 'utf8');
const result = await postcss([tailwindcss({ config: path.join(root, 'tailwind.config.cjs') }), autoprefixer()])
  .process(css, { from: sourceCss, to: path.join(assetsDir, 'app.css') });
fs.writeFileSync(path.join(assetsDir, 'app.css'), result.css);

const publicAssets = path.join(appRoot, 'public', 'assets');
if (fs.existsSync(publicAssets)) fs.cpSync(publicAssets, assetsDir, { recursive: true });

const template = fs.readFileSync(sourceIndex, 'utf8');
const output = template.replace(
  '<!-- build:assets -->',
  `<link rel="stylesheet" href="/assets/app.css?v=${version}" />\n    <script type="module" src="/assets/app.js?v=${version}"></script>`,
);
fs.writeFileSync(path.join(outDir, 'index.html'), output);
console.log(JSON.stringify({ built: true, version, output: outDir }));
