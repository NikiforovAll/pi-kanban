'use strict';

const fs = require('node:fs').promises;
const path = require('node:path');

let seq = 0;

// The board reads these files while pi writes them, so it must never see half a file.
// On Windows a rename over a file another handle has open fails with EPERM or EBUSY until it closes.
async function writeJsonAtomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${++seq}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(data, null, 2));
    for (let attempt = 1; ; attempt++) {
      try {
        await fs.rename(tmp, file);
        return;
      } catch (e) {
        if (attempt >= 10 || (e.code !== 'EPERM' && e.code !== 'EBUSY')) throw e;
        await new Promise((r) => setTimeout(r, attempt * 10));
      }
    }
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

module.exports = { writeJsonAtomic };
