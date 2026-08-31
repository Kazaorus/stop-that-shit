'use strict';

const assert = require('node:assert/strict');
const { resolveTimeout } = require('../src/options.cjs');

assert.equal(resolveTimeout({ timeoutMs: 12 }), 12);
assert.equal(resolveTimeout({}), 30);
