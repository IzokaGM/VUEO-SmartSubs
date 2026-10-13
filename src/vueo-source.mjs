import { ApiError } from './vueo-security.mjs'
/** Adapt ASS/SSA input to VTT before using the unchanged SmartSubsV2 translator. */
export function prepareSourceText(text) {
  if (!/^\[Events\]/mi.test(text)) return text
  let fields = ['layer','start','end','style','name','marginl','marginr','marginv','effect','text']
  let inEvents = false
  const cues = []
  const timestamp = value => {
    const m = String(value).trim().match(/^(\d{1,2}):(\d{2}):(\d{2})\.(\d{1,3})$/)
    if (!m || Number(m[2]) > 59 || Number(m[3]) > 59) return null
    return `${m[1].padStart(2,'0')}:${m[2]}:${m[3]}.${m[4].padEnd(3,'0')}`
  }
  for (const line of text.replace(/\r\n?/g,'\n').split('\n')) {
    if (/^\[/.test(line)) inEvents = /^\[Events\]/i.test(line)
    if (!inEvents) continue
    if (/^Format:/i.test(line)) { fields = line.slice(line.indexOf(':') + 1).split(',').map(x => x.trim().toLowerCase()); continue }
    if (!/^Dialogue:/i.test(line)) continue
    // Text must be last: commas in spoken text stay in the final field.
    if (fields.at(-1) !== 'text') throw new ApiError(422, 'UNSUPPORTED_ASS_FORMAT', 'ASS Text field must be last')
    const columns = line.slice(line.indexOf(':') + 1).split(',')
    const values = columns.slice(0, fields.length - 1)
    values.push(columns.slice(fields.length - 1).join(','))
    const start = timestamp(values[fields.indexOf('start')]), end = timestamp(values[fields.indexOf('end')])
    const content = values.at(-1)?.replace(/\\[Nn]/g,'\n').replace(/\\h/g,' ').trim()
    if (start && end && content) cues.push(`${start} --> ${end}\n${content}`)
  }
  if (!cues.length) throw new ApiError(422, 'NO_TIMED_CUES', 'ASS/SSA contains no usable timed dialogue')
  return `WEBVTT\n\n${cues.join('\n\n')}\n`
}
