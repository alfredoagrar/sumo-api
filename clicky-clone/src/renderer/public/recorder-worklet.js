// Recoge el audio del micrófono en bloques de ~2048 muestras y los manda al hilo principal.
class BuddyRecorder extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Float32Array(2048)
    this.length = 0
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel) {
      let offset = 0
      while (offset < channel.length) {
        const n = Math.min(channel.length - offset, this.buffer.length - this.length)
        this.buffer.set(channel.subarray(offset, offset + n), this.length)
        this.length += n
        offset += n
        if (this.length === this.buffer.length) {
          this.port.postMessage(this.buffer.slice(0))
          this.length = 0
        }
      }
    }
    return true
  }
}

registerProcessor('buddy-recorder', BuddyRecorder)
