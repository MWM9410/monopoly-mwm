import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const serverPath = resolve('server.js');
const mingziPath = resolve('mingzi.txt');
const outputPath = resolve('public/server-browser.js');

let server = readFileSync(serverPath, 'utf-8');
const mingzi = readFileSync(mingziPath, 'utf-8');

// Step 1: Inline mingzi.txt
const mingziEscaped = mingzi
  .replace(/\\/g, '\\\\')
  .replace(/"/g, '\\"')
  .replace(/\r\n/g, '\\n')
  .replace(/\n/g, '\\n')
  .replace(/\r/g, '\\n');

const oldLine = "const mzContent = require('fs').readFileSync('mingzi.txt', 'utf-8').split('\\n');";
const newLine = `const mzContent = "${mingziEscaped}".split('\\n');`;
server = server.replace(oldLine, newLine);

// Step 2: Set CLOUD=true
server = server.replace(
  "const IS_CLOUD = process.env.CLOUD === 'true' || process.env.RENDER === 'true';",
  'const IS_CLOUD = true;'
);

// Step 3: Remove server.listen + idle shutdown
const lastIdx = server.lastIndexOf("if (IS_CLOUD) {\n  const PORT");
if (lastIdx >= 0) {
  server = server.substring(0, lastIdx);
}

// Step 4: Expose io instance for GameEngine
// Replace `const io = new Server({...});` with `const io = new Server({...}); window.__gameIo = io;`
const ioRe = /const io = new Server\(\{[\s\S]*?\}\s*\)\s*;/;
if (ioRe.test(server)) {
  server = server.replace(ioRe, match => match + ' window.__gameIo = io;');
}

// Step 5: Add engine ready marker
server += '\n\nwindow.__gameEngineReady = true;\n';

writeFileSync(outputPath, server, 'utf-8');
console.log(`✓ Generated ${outputPath} (${server.length} bytes)`);

// Verify mzContent encoding
const mzLine = server.split('\n').find(l => l.startsWith('const mzContent'));
if (mzLine) {
  const match = mzLine.match(/"([^"]+)"/);
  if (match && match[1]) {
    const firstChar = match[1].charCodeAt(0);
    console.log(`First data char code: ${firstChar} (${String.fromCodePoint(firstChar)})`);
    if (firstChar >= 0x4e00 && firstChar <= 0x9fff) {
      console.log('✓ Chinese encoding OK');
    } else {
      console.log('⚠ Chinese encoding may be wrong (expected CJK, got ' + firstChar + ')');
    }
  }
}
