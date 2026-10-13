import { readFileSync, writeFileSync } from 'node:fs'
const account = process.env.CLOUDFLARE_ACCOUNT_ID
const token = process.env.CLOUDFLARE_API_TOKEN
if (!account || !token) throw new Error('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN')
async function api(path, method = 'GET', body) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/${path}`, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {})
  })
  const data = await res.json()
  if (!res.ok || !data.success) throw new Error(`Cloudflare provisioning failed for ${path.split('?')[0]} (HTTP ${res.status}); check account and token permissions`)
  return data
}
async function list(path) {
  const items = []
  for (let page = 1; page <= 100; page++) {
    const data = await api(`${path}?page=${page}&per_page=100`)
    items.push(...data.result)
    if (page >= (data.result_info?.total_pages || 1)) return items
  }
  throw new Error('Cloudflare resource listing exceeded pagination limit')
}
const title = 'vueo-smartsubs-cache'
const namespaces = await list('storage/kv/namespaces')
let kv = namespaces.find(item => item.title === title)
if (!kv) kv = (await api('storage/kv/namespaces', 'POST', { title })).result
const queueName = 'vueo-smartsubs-translation'
const queues = await list('queues')
if (!queues.some(item => item.queue_name === queueName)) await api('queues', 'POST', { queue_name: queueName })
const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'))
if (config.name !== 'vueo-smartsubs' || config.queues?.producers?.[0]?.queue !== queueName) throw new Error('Unexpected resource identity; refusing deployment')
config.kv_namespaces = [{ binding: 'SMARTSUBS_CACHE', id: kv.id }]
writeFileSync('wrangler.generated.json', JSON.stringify(config, null, 2) + '\n')
console.log('VUEO-SmartSubs isolated KV and Queue are ready; generated deployment configuration')
