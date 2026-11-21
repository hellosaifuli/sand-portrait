// Writes sand-portrait.mjs (ES module) from sand-portrait.js (UMD), so there is one source of truth.
//   node scripts/build.js
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'sand-portrait.js'), 'utf8');
const header = src.slice(0, src.indexOf('*/') + 2);
const open = "})(typeof self !== 'undefined' ? self : this, ";
const start = src.indexOf(open) + open.length;
const end = src.lastIndexOf(');');
if (start < open.length || end < start) throw new Error('UMD wrapper not found');
const factory = src.slice(start, end).trim();
fs.writeFileSync(path.join(__dirname, '..', 'sand-portrait.mjs'),
  `${header}\nconst SandPortrait = (${factory})();\nexport default SandPortrait;\nexport { SandPortrait };\n`);
console.log('wrote sand-portrait.mjs');
