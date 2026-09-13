// Reproducible backend bundle for the CodeOrquestra runtime.
// Produces self-contained ESM entrypoints under dist/ so the installed plugin
// never runs `npm install` at session start. Production dependencies are
// bundled; no Claude Code CLI is ever bundled or vendored — the runtime drives
// the CLI the user installed, through an explicit executable path. Package
// metadata is read from the real package directories (some packages do not
// export their package.json), and third-party license texts are collected
// into dist/THIRD_PARTY_NOTICES.txt.
import { build } from 'esbuild';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const runtimeRoot = path.dirname(fileURLToPath(import.meta.url));
const distRoot = path.join(runtimeRoot, 'dist');

const entryPoints = {
  codeorquestra: 'src/cli/main.ts',
  worker: 'src/worker/main.ts',
  'mcp-stdio': 'src/mcp/main.ts',
};

// Modules that must stay outside the bundle. Keep this list empty unless a
// dependency proves impossible to bundle; anything listed here must also be
// shipped explicitly by the release step.
const external = [];

await mkdir(distRoot, { recursive: true });
// Purge every root-level bundle, not just the current entry names: a renamed
// entrypoint must not leave a stale, shippable copy of the previous build.
for (const entry of await readdir(distRoot, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith('.mjs')) await rm(path.join(distRoot, entry.name), { force: true });
}
await rm(path.join(distRoot, 'build-info.json'), { force: true });
await rm(path.join(distRoot, 'THIRD_PARTY_NOTICES.txt'), { force: true });

const result = await build({
  absWorkingDir: runtimeRoot,
  entryPoints,
  outdir: distRoot,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: ['node22'],
  format: 'esm',
  packages: 'bundle',
  external,
  sourcemap: false,
  minify: false,
  treeShaking: true,
  legalComments: 'none',
  logLevel: 'info',
  metafile: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  banner: {
    js: [
      "import { createRequire as __codeorquestraCreateRequire } from 'node:module';",
      'const require = __codeorquestraCreateRequire(import.meta.url);',
    ].join('\n'),
  },
});

// Vite owns the production dashboard output, but a write-free esbuild pass
// gives us an exact module graph for the same browser entrypoint. License
// collection must cover both shipped graphs, not only the Node entrypoints.
const dashboardAnalysis = await build({
  absWorkingDir: runtimeRoot,
  entryPoints: { dashboard: 'dashboard/src/main.tsx' },
  outdir: path.join(distRoot, '.dashboard-analysis'),
  bundle: true,
  write: false,
  platform: 'browser',
  target: ['es2022'],
  format: 'esm',
  sourcemap: false,
  minify: true,
  treeShaking: true,
  legalComments: 'none',
  logLevel: 'silent',
  metafile: true,
  define: { 'process.env.NODE_ENV': '"production"' },
});

async function readPackageJson(packageDir) {
  try {
    return JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

const runtimePackage = JSON.parse(await readFile(path.join(runtimeRoot, 'package.json'), 'utf8'));
const dependencyVersions = {};
for (const name of Object.keys(runtimePackage.dependencies ?? {})) {
  const manifest = await readPackageJson(path.join(runtimeRoot, 'node_modules', ...name.split('/')));
  dependencyVersions[name] = manifest?.version ?? null;
}

const bundledInputs = [...Object.keys(result.metafile.inputs), ...Object.keys(dashboardAnalysis.metafile.inputs)].filter((file) => file.includes('node_modules/'));
const packageDirs = new Map();
for (const file of bundledInputs) {
  const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(file);
  if (!match) continue;
  const dir = match[1];
  const name = dir.slice(dir.lastIndexOf('node_modules/') + 'node_modules/'.length);
  if (!packageDirs.has(name)) packageDirs.set(name, path.join(runtimeRoot, dir));
}
const bundledPackages = [...packageDirs.keys()].sort();

const notices = [
  'CodeOrquestra runtime — third-party notices',
  'This bundle embeds the packages listed below. Each section reproduces the license or notice files found in the installed package.',
  'No Claude Code binary or vendor SDK is bundled: the runtime drives the CLI the user installed separately.',
  '',
];
for (const name of bundledPackages) {
  const dir = packageDirs.get(name);
  const manifest = await readPackageJson(dir);
  notices.push('='.repeat(78));
  notices.push(`${name}@${manifest?.version ?? 'unknown'} — license field: ${typeof manifest?.license === 'string' ? manifest.license : JSON.stringify(manifest?.license ?? null)}`);
  notices.push('='.repeat(78));
  let files = [];
  try {
    files = (await readdir(dir)).filter((entry) => /^(licen[cs]e|notice|copying)/i.test(entry));
  } catch {
    files = [];
  }
  if (files.length === 0) {
    notices.push('(no license/notice file shipped in the package directory)');
  }
  for (const file of files.sort()) {
    notices.push(`--- ${file} ---`);
    notices.push((await readFile(path.join(dir, file), 'utf8')).trim());
  }
  notices.push('');
}

await writeFile(path.join(distRoot, 'package.json'), JSON.stringify({ type: 'module', private: true }, null, 2) + '\n');
await writeFile(path.join(distRoot, 'THIRD_PARTY_NOTICES.txt'), notices.join('\n'));
await writeFile(path.join(distRoot, 'build-info.json'), JSON.stringify({
  name: runtimePackage.name,
  version: runtimePackage.version,
  builtWithNode: process.version,
  entrypoints: Object.fromEntries(Object.keys(entryPoints).map((name) => [name, `${name}.mjs`])),
  dependencyVersions,
  vendorSdkBundled: false,
  bundledPackages,
  external,
  notices: 'THIRD_PARTY_NOTICES.txt',
}, null, 2) + '\n');
