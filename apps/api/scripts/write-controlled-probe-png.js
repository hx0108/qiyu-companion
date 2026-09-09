'use strict';

const { mkdirSync, writeFileSync } = require('node:fs');
const { dirname, resolve } = require('node:path');
const { createControlledPng } = require('./controlled-probe-png');

const outputIndex = process.argv.indexOf('--out');
const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : '';
if (!output) throw new Error('--out is required.');
const target = resolve(output);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, createControlledPng(), { flag: 'w' });
process.stdout.write(`${target}\n`);
