import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'dist', 'notice');
await mkdir(path.join(output, 'ui', 'shared'), { recursive: true });
await mkdir(path.join(output, 'icons'), { recursive: true });
const html = await readFile(path.join(root, 'site/notice/index.html'), 'utf8');
await writeFile(path.join(output, 'index.html'), html);
const [sharedStyles, noticeStyles] = await Promise.all([
  readFile(path.join(root, 'src/ui/shared/styles.css'), 'utf8'),
  readFile(path.join(root, 'site/notice/styles.css'), 'utf8')
]);
await writeFile(path.join(output, 'ui/shared/styles.css'), sharedStyles + noticeStyles);
await copyFile(path.join(root, 'icons/icon-48.png'), path.join(output, 'icons/icon-48.png'));
await copyFile(path.join(root, 'site/notice/icons/x-logo.svg'), path.join(output, 'icons/x-logo.svg'));
await build({
  absWorkingDir: root, entryPoints: ['site/notice/index.ts'],
  outfile: path.join(output, 'notice.js'), bundle: true, format: 'iife',
  target: 'chrome111', minify: true, sourcemap: false, legalComments: 'none'
});
process.stdout.write(`Built public notice: ${output}\n`);
