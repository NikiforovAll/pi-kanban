const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readdirSync } = require('fs');
const { execFileSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const files = [
  'server.js',
  'cli.js',
  ...readdirSync(path.join(root, 'lib')).filter((f) => f.endsWith('.js')).map((f) => `lib/${f}`),
  ...readdirSync(path.join(root, 'public')).filter((f) => f.endsWith('.js')).map((f) => `public/${f}`),
];

describe('syntax', () => {
  for (const file of files) {
    it(`${file} parses`, () => {
      assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'pipe' }));
    });
  }
});
