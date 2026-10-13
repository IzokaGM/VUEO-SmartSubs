import { ApiError } from './vueo-security.mjs'
const json = (value, status = 200) => Response.json(value, { status })
const RETENTION_MS = 24 * 60 * 60 * 1000
/** SQLite Durable Object owns single-flight transitions and encrypted input. */
export class VueoSmartSubsJob {
  constructor(state, env) { this.state = state; this.env = env }
  async fetch(request) {
    const path = new URL(request.url).pathname
    if (path === '/submit') return this.state.blockConcurrencyWhile(async () => {
      const input = await request.json()
      const old = await this.state.storage.get('job')
      if (old && old.owner !== input.owner) return json({ code: 'FORBIDDEN' }, 403)
      if (old && ['queued', 'running', 'ready'].includes(old.status)) return json(this.summary(old))
      const job = { id: input.id, owner: input.owner, sealedInput: input.sealedInput, cacheKey: input.cacheKey, status: input.readyVtt ? 'ready' : 'queued', createdAt: Date.now(), attempts: 0, generation: (old?.generation || 0) + 1 }
      await this.state.storage.put('job', job)
      await this.state.storage.setAlarm(Date.now() + RETENTION_MS)
      if (input.readyVtt) await this.state.storage.put('result', input.readyVtt)
      else {
        try { await this.env.VUEO_TRANSLATION_QUEUE.send({ jobId: job.id, generation: job.generation }) }
        catch { job.status = 'failed'; job.error = { code: 'QUEUE_UNAVAILABLE', message: 'Translation queue is unavailable' }; await this.state.storage.put('job', job) }
      }
      return json(this.summary(job))
    })
    if (path === '/claim') return this.state.blockConcurrencyWhile(async () => {
      const input = await request.json(); const job = await this.state.storage.get('job')
      if (!job || job.generation !== input.generation || ['ready','failed'].includes(job.status)) return json({ skip: true })
      if (job.status === 'running' && Date.now() - job.startedAt < 15 * 60 * 1000) return json({ busy: true })
      job.status = 'running'; job.startedAt = Date.now(); job.attempts = Number(input.attempts || 1)
      await this.state.storage.put('job', job)
      return json(job)
    })
    if (path === '/finish') return this.state.blockConcurrencyWhile(async () => {
      const input = await request.json(); const job = await this.state.storage.get('job')
      if (!job || job.generation !== input.generation || job.attempts !== input.attempts || job.status !== 'running') return json({ stale: true })
      if (input.vtt) {
        if (Buffer.byteLength(input.vtt) > 1536 * 1024) throw new ApiError(413, 'RESULT_TOO_LARGE', 'Translated result is too large')
        await this.state.storage.put('result', input.vtt)
        job.status = 'ready'; delete job.sealedInput; delete job.error
      } else {
        job.status = input.retry ? 'queued' : 'failed'; job.error = input.error
        if (!input.retry) delete job.sealedInput
      }
      await this.state.storage.put('job', job)
      await this.state.storage.setAlarm(Date.now() + RETENTION_MS)
      return json(this.summary(job))
    })
    const job = await this.state.storage.get('job')
    if (!job) return json({ code: 'JOB_NOT_FOUND' }, 404)
    if (path === '/status') {
      if (request.headers.get('x-vueo-user') !== job.owner) return json({ code: 'FORBIDDEN' }, 403)
      return json(this.summary(job))
    }
    if (path === '/result') {
      if (job.status !== 'ready') return json({ status: job.status, code: 'RESULT_NOT_READY' }, 409)
      const vtt = await this.state.storage.get('result')
      return vtt ? new Response(vtt, { headers: { 'content-type': 'text/vtt; charset=utf-8' } }) : json({ code: 'RESULT_EXPIRED' }, 410)
    }
    return json({ code: 'NOT_FOUND' }, 404)
  }
  summary(job) {
    return { jobId: job.id, status: job.status, createdAt: job.createdAt, attempts: job.attempts, ...(job.error ? { error: job.error } : {}) }
  }
  async alarm() { await this.state.storage.deleteAll() }
}
