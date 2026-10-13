import { readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
function walk(path) { return readdirSync(path).flatMap(name => statSync(`${path}/${name}`).isDirectory() ? walk(`${path}/${name}`) : [`${path}/${name}`]) }
for (const file of [...walk('src'), ...walk('scripts'), ...walk('test')].filter(p => /\.(mjs|js)$/.test(p))) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status || 1)
}
