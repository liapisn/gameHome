/** Tile images into a labelled contact sheet.  npx tsx scripts/contact-sheet.mts <out.jpg> <cols> <img...> */
import path from "node:path";
import sharp from "sharp";
const [out, colsArg, ...files] = process.argv.slice(2);
const cols = Number(colsArg);
const TW = 600;
const tiles = await Promise.all(
  files.map(async (f) => {
    const img = sharp(f).resize(TW);
    const { height } = await img.clone().metadata().then(async () => (await img.clone().toBuffer({ resolveWithObject: true })).info);
    const label = Buffer.from(`<svg width="${TW}" height="40"><rect width="90" height="40" fill="#000"/><text x="10" y="29" font-size="26" font-family="Helvetica" font-weight="bold" fill="#fff">${path.parse(f).name}</text></svg>`);
    return { buf: await img.composite([{ input: label, top: 0, left: 0 }]).toBuffer(), height };
  }),
);
const TH = Math.max(...tiles.map((t) => t.height));
const rows = Math.ceil(tiles.length / cols);
await sharp({ create: { width: cols * TW, height: rows * TH, channels: 3, background: "#222" } })
  .composite(tiles.map((t, i) => ({ input: t.buf, left: (i % cols) * TW, top: Math.floor(i / cols) * TH })))
  .jpeg({ quality: 80 })
  .toFile(out);
