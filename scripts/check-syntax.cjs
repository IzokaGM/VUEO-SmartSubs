'use strict'
const {existsSync, readdirSync} = require('node:fs')
const {join, resolve} = require('node:path')
const {spawnSync} = require('node:child_process')
const root = resolve(__dirname, '..')
for (const directory of ['src', 'scripts', 'test', 'tests']) {
 const path = join(root, directory)
 // The supplied ZIP workflow deliberately removes root test/test(s) folders.
 // Source and scripts remain required; missing production paths still fail.
 if ((directory === 'test' || directory === 'tests') && !existsSync(path)) continue
 for (const entry of readdirSync(path, {withFileTypes:true})) {
  if (!entry.isFile() || !/\.(?:js|mjs|cjs)$/.test(entry.name)) continue
  const result=spawnSync(process.execPath,['--check',join(path,entry.name)],{stdio:'inherit'})
  if(result.error) throw result.error
  if(result.status!==0) process.exit(result.status || 1)
 }
}
