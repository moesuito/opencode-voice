/** Builds a canonical 44-byte PCM WAV container around raw little-endian samples. */
export function buildWav(pcm: Buffer, sampleRate: number, channels = 1, bitsPerSample = 16): Buffer {
  const header = Buffer.alloc(44)
  const byteRate = (sampleRate * channels * bitsPerSample) / 8
  header.write("RIFF", 0, "ascii")
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write("WAVE", 8, "ascii")
  header.write("fmt ", 12, "ascii")
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE((channels * bitsPerSample) / 8, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write("data", 36, "ascii")
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}
