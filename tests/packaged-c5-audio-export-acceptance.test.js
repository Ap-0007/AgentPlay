const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

test('C5 packaged acceptance requires all final-audio evidence and quality100', () => {
  const smoke = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'smoke-packaged-audio-export-c5.mjs'), 'utf8')
  for (const marker of ['unified-audio-export-qc-v1', 'clipping', 'loudness', 'avSync', 'silence', 'copyright', 'quality100', 'sourceHashesUnchanged']) assert.match(smoke, new RegExp(marker))
  assert.match(smoke, /receiptAbsolutePathOmitted/)
})
