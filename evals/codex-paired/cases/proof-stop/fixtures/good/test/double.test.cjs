'use strict';

const assert = require('node:assert/strict');
const { double } = require('../src/double.cjs');

assert.equal(double(4), 8);
