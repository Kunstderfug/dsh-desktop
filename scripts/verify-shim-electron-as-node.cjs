'use strict'
// Manual verification: run the pnpm shim exactly as production writes it on
// darwin — Electron binary + ELECTRON_RUN_AS_NODE preamble — and confirm it
// answers as pnpm (i.e. booted as Node, not as the app).
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const dir = '/tmp/dsh-shim-test/.desktop-bin'
fs.mkdirSync(dir, { recursive: true })
const electron = path.resolve('node_modules/.bin/electron')
const pnpmEntry = path.resolve('node_modules/pnpm/bin/pnpm.cjs')
const body = [
  '#!/bin/sh',
  'export ELECTRON_RUN_AS_NODE=1',
  `exec '${electron}' '${pnpmEntry}' "$@"`,
  ''
].join('\n')
fs.writeFileSync(path.join(dir, 'pnpm'), body, { mode: 0o755 })
const out = execFileSync(path.join(dir, 'pnpm'), ['--version'], {
  encoding: 'utf8',
  timeout: 30000
})
console.log('shim pnpm --version →', out.trim())
fs.rmSync('/tmp/dsh-shim-test', { recursive: true, force: true })
