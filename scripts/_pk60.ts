import fs from 'node:fs';
import PDFDocument from 'pdfkit';
const T = '\u0645\u064f\u062d\u064e\u0645\u064e\u0651\u062f\u064c \u0631\u064e\u0633\u064f\u0648\u0644\u064f \u0627\u0644\u0644\u064e\u0651\u0647\u0650';
async function run() {
  const doc = new PDFDocument({ size: [400, 140], margin: 0, compress: true });
  const chunks: Buffer[] = [];
  doc.on('data', (c?: Uint8Array) => { if (c) chunks.push(Buffer.from(c)); });
  const done = new Promise<void>((res) => doc.on('end', () => res()));
  doc.registerFont('A', fs.readFileSync('public/fonts/Amiri-Regular.ttf'));
  doc.font('A').fontSize(60).fillColor('#000').text(T, 20, 20, { lineBreak: false } as never);
  doc.end();
  await done;
  fs.writeFileSync('/tmp/pk60.pdf', Buffer.concat(chunks));
}
run();
