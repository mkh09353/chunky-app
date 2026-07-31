const SAMPLE_RATE = 24_000

export function pcm16Base64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i]!))
    view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
  }
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function pcm16FromBase64(base64: string): Float32Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  const view = new DataView(bytes.buffer)
  const samples = new Float32Array(Math.floor(bytes.length / 2))
  for (let i = 0; i < samples.length; i += 1) samples[i] = view.getInt16(i * 2, true) / 0x8000
  return samples
}

const workletSource = `class ChunkyPcmProcessor extends AudioWorkletProcessor {
  constructor() { super(); this.frames = []; this.size = 0; }
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    this.frames.push(new Float32Array(input)); this.size += input.length;
    const target = Math.max(1, Math.round(sampleRate * 0.075));
    if (this.size >= target) {
      const out = new Float32Array(this.size); let offset = 0;
      for (const frame of this.frames) { out.set(frame, offset); offset += frame.length; }
      this.frames = []; this.size = 0; this.port.postMessage(out, [out.buffer]);
    }
    return true;
  }
}
registerProcessor('chunky-pcm', ChunkyPcmProcessor);`

/** Captures mono 24kHz mic samples in approximately 75ms PCM16 chunks. */
export class MicCapture {
  private context: AudioContext | null = null
  private stream: MediaStream | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private node: AudioWorkletNode | null = null
  private blobUrl: string | null = null

  async start(onChunk: (base64: string) => void): Promise<void> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: SAMPLE_RATE } })
    } catch (error) {
      const message = error instanceof DOMException && error.name === "NotAllowedError" ? "Microphone permission was denied. Allow microphone access and try again." : error instanceof Error ? error.message : "Could not access the microphone."
      throw new Error(message)
    }
    this.context = new AudioContext({ sampleRate: SAMPLE_RATE })
    this.blobUrl = URL.createObjectURL(new Blob([workletSource], { type: "application/javascript" }))
    await this.context.audioWorklet.addModule(this.blobUrl)
    this.source = this.context.createMediaStreamSource(this.stream)
    this.node = new AudioWorkletNode(this.context, "chunky-pcm", { channelCount: 1 })
    this.node.port.onmessage = (event: MessageEvent<Float32Array>) => onChunk(pcm16Base64(event.data))
    this.source.connect(this.node)
    // Keep the worklet alive without audibly monitoring the microphone.
    this.node.connect(this.context.destination)
  }

  stop(): void {
    this.node?.disconnect(); this.source?.disconnect()
    this.stream?.getTracks().forEach((track) => track.stop())
    void this.context?.close()
    if (this.blobUrl) URL.revokeObjectURL(this.blobUrl)
    this.context = null; this.stream = null; this.source = null; this.node = null; this.blobUrl = null
  }
}

/** Sequential PCM player; flush stops active output for server-VAD barge-in. */
export class PcmPlayer {
  private context: AudioContext | null = null
  private nextAt = 0
  private sources = new Set<AudioBufferSourceNode>()

  append(base64: string): void {
    try {
      this.context ??= new AudioContext({ sampleRate: SAMPLE_RATE })
      const context = this.context
      const samples = pcm16FromBase64(base64)
      const buffer = context.createBuffer(1, samples.length, SAMPLE_RATE)
      // Copy into a fresh ArrayBuffer-backed view: Web Audio's DOM types do
      // not accept a potentially SharedArrayBuffer-backed typed array.
      const channel = new Float32Array(samples.length)
      channel.set(samples)
      buffer.copyToChannel(channel, 0)
      const source = context.createBufferSource()
      source.buffer = buffer; source.connect(context.destination)
      const at = Math.max(context.currentTime, this.nextAt)
      source.start(at); this.nextAt = at + buffer.duration
      this.sources.add(source); source.onended = () => this.sources.delete(source)
    } catch {
      // A malformed audio delta must not take down a live voice session.
    }
  }

  flush(): void {
    for (const source of this.sources) { try { source.stop() } catch {} }
    this.sources.clear(); this.nextAt = this.context?.currentTime ?? 0
  }

  close(): void { this.flush(); void this.context?.close(); this.context = null }
}
