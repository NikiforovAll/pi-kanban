// Builds the images that are not screenshots from tracked inputs: the og image, the README poster
// and the PWA icons. Run `npm run shots` first when the board shots change.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const at = (p) => path.join(root, p);
const shot = (name) => at(`website/public/shots/nord/${name}.webp`);
const icon = at('public/icons/icon-svg.svg');
const { width: iconWidth } = await sharp(icon).metadata();

const jobs = [
  ['website/public/og.png', () => sharp(shot('pi-board-light')).resize(1200, 630, { fit: 'cover', position: 'top' })],
  ['assets/pi-kanban-poster.png', () => sharp(shot('pi-board-dark'))],
  ...[192, 512].map((size) => [`public/icons/icon-${size}.png`, () => sharp(icon, { density: (72 * size) / iconWidth }).resize(size, size)]),
];

for (const [out, make] of jobs) {
  const { width, height, size } = await make().png({ compressionLevel: 9 }).toFile(at(out));
  console.log(`${out}: ${width}x${height}, ${size} bytes`);
}
