import { copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requestedTarget = process.argv[2] ?? 'extension';
const validTargets = new Set(['extension', 'e2e']);

if (!validTargets.has(requestedTarget)) {
  throw new Error(`Unknown build target: ${requestedTarget}`);
}

const uiEntries = ['popup', 'dashboard', 'options', 'onboarding'];
const commonBuild = {
  absWorkingDir: root,
  bundle: true,
  target: 'chrome111',
  logLevel: 'info',
  legalComments: 'none',
  sourcemap: false
};

async function ensureParent(file) {
  await mkdir(path.dirname(file), { recursive: true });
}

async function copy(source, target) {
  await ensureParent(target);
  await copyFile(path.join(root, source), target);
}

async function buildTarget(target) {
  const outdir = path.join(root, 'dist', target);
  const allowedOrigins = target === 'e2e'
    ? ['https://chatgpt.com', 'https://chat.openai.com', 'http://127.0.0.1:43996']
    : ['https://chatgpt.com', 'https://chat.openai.com'];
  const define = {
    __ROUTE_INSPECTOR_ALLOWED_ORIGINS__: JSON.stringify(allowedOrigins)
  };

  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });

  await build({
    ...commonBuild,
    entryPoints: { 'background/service-worker': 'src/background/service-worker.ts' },
    outdir,
    format: 'esm',
    define
  });

  await build({
    ...commonBuild,
    entryPoints: {
      'content/page-hook': 'src/content/page-hook.ts',
      'content/bridge': 'src/content/bridge.ts',
      ...Object.fromEntries(uiEntries.map((name) => [`ui/${name}/index`, `src/ui/${name}/index.ts`]))
    },
    outdir,
    format: 'iife',
    define
  });

  for (const name of uiEntries) {
    await copy(`src/ui/${name}/index.html`, path.join(outdir, 'ui', name, 'index.html'));
  }
  await copy('src/ui/shared/styles.css', path.join(outdir, 'ui', 'shared', 'styles.css'));
  await copy('schemas/route-turn.v1.schema.json', path.join(outdir, 'schemas', 'route-turn.v1.schema.json'));
  await cp(path.join(root, '_locales'), path.join(outdir, '_locales'), { recursive: true });
  await cp(path.join(root, 'icons'), path.join(outdir, 'icons'), { recursive: true });

  const manifest = JSON.parse(await readFile(path.join(root, 'manifest', 'manifest.json'), 'utf8'));
  if (target === 'e2e') {
    manifest.name = 'ChatGPT Route Inspector — E2E';
    manifest.host_permissions.push('http://127.0.0.1/*');
    for (const contentScript of manifest.content_scripts) contentScript.matches.push('http://127.0.0.1/*');
  }
  await writeFile(path.join(outdir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  process.stdout.write(`Built ${target}: ${outdir}\n`);
}

await buildTarget(requestedTarget);
