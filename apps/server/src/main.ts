import { serve } from '@hono/node-server'
import { createApp } from './app'
import { loadServerConfig } from './config'

const config = loadServerConfig(process.env)

serve({ fetch: createApp().fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`bullet server listening on http://${info.address}:${info.port}`)
})
