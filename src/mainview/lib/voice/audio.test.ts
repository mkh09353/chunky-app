import { describe, expect, test } from "bun:test"
import { pcm16Base64 } from "./audio"

describe("pcm16Base64", () => {
  test("encodes little-endian PCM16 samples", () => {
    expect(pcm16Base64(new Float32Array([-1, 0, 1]))).toBe("AIAAAP9/")
  })
})
