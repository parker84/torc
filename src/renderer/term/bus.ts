/**
 * A PTY starts producing output the instant it spawns, which can be before the
 * matching TerminalPane has mounted. A single app-level subscription buffers
 * per session id and hands everything over the moment a writer attaches, so no
 * output is ever lost to that race.
 */
type Writer = (chunk: string) => void

const writers = new Map<string, Writer>()
const buffers = new Map<string, string[]>()

window.torc.onData((id, chunk) => {
  const writer = writers.get(id)
  if (writer) {
    writer(chunk)
    return
  }
  const buffered = buffers.get(id)
  if (buffered) buffered.push(chunk)
  else buffers.set(id, [chunk])
})

export function attachWriter(id: string, writer: Writer): () => void {
  const buffered = buffers.get(id)
  if (buffered) {
    buffers.delete(id)
    for (const chunk of buffered) writer(chunk)
  }
  writers.set(id, writer)
  return () => {
    if (writers.get(id) === writer) writers.delete(id)
  }
}

export function forgetSession(id: string): void {
  writers.delete(id)
  buffers.delete(id)
}
