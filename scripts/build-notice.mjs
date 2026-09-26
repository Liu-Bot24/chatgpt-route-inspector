import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'dist', 'notice');
await mkdir(path.join(output, 'ui', 'shared'), { recursive: true });
await mkdir(path.join(output, 'icons'), { recursive: true });
const html = (await readFile(path.join(root, 'src/ui/announcement/index.html'), 'utf8'))
  .replace('href="../shared/styles.css"', 'href="/ui/shared/styles.css"')
  .replace('src="index.js"', 'src="/notice.js"');
await writeFile(path.join(output, 'index.html'), html);
await copyFile(path.join(root, 'src/ui/shared/styles.css'), path.join(output, 'ui/shared/styles.css'));
await copyFile(path.join(root, 'icons/icon-48.png'), path.join(output, 'icons/icon-48.png'));
await build({
  absWorkingDir: root, entryPoints: ['src/ui/announcement/web.ts'],
  outfile: path.join(output, 'notice.js'), bundle: true, format: 'iife',
  target: 'chrome111', minify: true, sourcemap: false, legalComments: 'none'
});
process.stdout.write(`Built public notice: ${output}\n`);
