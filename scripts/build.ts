import { cp, mkdir, rm } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

await rm('dist', { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: [
    'src/background.ts',
    'src/popup/index.ts',
    'src/options/index.ts',
  ],
  root: 'src',
  outdir: 'dist',
  target: 'browser',
  format: 'esm',
  sourcemap: 'external',
  naming: '[dir]/[name].[ext]',
});
if (!result.success)
  throw new AggregateError(result.logs, 'Extension build failed');
for (const directory of ['popup', 'options']) {
  await mkdir(`dist/${directory}`, { recursive: true });
  await cp(`src/${directory}/index.html`, `dist/${directory}/index.html`);
}
await cp('public/manifest.json', 'dist/manifest.json');
const css = Bun.spawn(
  [
    'bun',
    'node_modules/@tailwindcss/cli/dist/index.mjs',
    '-i',
    'src/style.css',
    '-o',
    'dist/style.css',
    '--minify',
  ],
  { stdout: 'inherit', stderr: 'inherit' },
);
if ((await css.exited) !== 0) throw new Error('CSS build failed');

// Generate a small local PNG intake-arrow icon; no remote assets or image dependency.
const size = 128;
const pixels = Buffer.alloc(size * (size * 4 + 1));
for (let y = 0; y < size; y++)
  for (let x = 0; x < size; x++) {
    const offset = y * (size * 4 + 1) + 1 + x * 4;
    const arrow =
      (x >= 56 && x < 72 && y >= 24 && y < 73) ||
      (y >= 56 && y <= 88 && Math.abs(x - 64) <= 88 - y) ||
      (y >= 96 && y < 104 && x >= 28 && x < 100) ||
      (((x >= 28 && x < 36) || (x >= 92 && x < 100)) && y >= 84 && y < 100);
    pixels.set(arrow ? [255, 255, 255, 255] : [3, 105, 161, 255], offset);
  }
function chunk(type: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(Bun.hash.crc32(body));
  return Buffer.concat([length, body, crc]);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(size, 0);
header.writeUInt32BE(size, 4);
header[8] = 8;
header[9] = 6;
await Bun.write(
  'dist/icon.png',
  Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]),
);
console.log(`Load unpacked: ${process.cwd()}/dist`);
