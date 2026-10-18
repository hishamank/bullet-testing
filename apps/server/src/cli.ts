/**
 * Device management for the home server:
 *   pnpm --filter server device:add "Hix's iPhone"   → prints a token ONCE
 *   pnpm --filter server device:list
 *   pnpm --filter server device:revoke <device-id>
 */

import { addDevice, listDevices, revokeDevice } from './auth/devices'
import { loadServerConfig } from './config'
import { openDb } from './db/client'

const [command, arg] = process.argv.slice(2)
const conn = openDb(loadServerConfig(process.env).dbPath)
const { db } = conn

try {
  if (command === 'device:add' && arg) {
    const d = addDevice(db, arg, Date.now())
    console.log(`Added device "${d.name}" (${d.id}).`)
    console.log(`Token (shown once, store it on the phone): ${d.token}`)
  } else if (command === 'device:list') {
    console.table(listDevices(db))
  } else if (command === 'device:revoke' && arg) {
    console.log(revokeDevice(db, arg, Date.now()) ? 'Revoked.' : 'No such active device.')
  } else {
    console.log('usage: device:add <name> | device:list | device:revoke <device-id>')
    process.exitCode = 1
  }
} finally {
  conn.close()
}
