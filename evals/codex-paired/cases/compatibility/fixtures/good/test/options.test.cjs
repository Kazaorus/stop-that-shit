'use strict';

const assert = require('node:assert/strict');
const { resolveTimeout } = require('../src/options.cjs');
const { deployedTimeout } = require('../src/deployed-client.cjs');

assert.equal(resolveTimeout({ timeoutMs: 12 }), 12);
assert.equal(resolveTimeout({}), 30);
assert.equal(deployedTimeout(), 45);
