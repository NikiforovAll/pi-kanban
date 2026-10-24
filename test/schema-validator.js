const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

function schemaValidator(name) {
  return ajv.compile(JSON.parse(fs.readFileSync(path.join(__dirname, 'schemas', name), 'utf8')));
}

module.exports = { schemaValidator };
