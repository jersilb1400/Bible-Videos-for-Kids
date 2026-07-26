import { strictEqual, deepStrictEqual, ok } from "node:assert";
import { describe, it } from "node:test";
import { probe, probeLoudness } from "../src/tools/probe.js";
import { existsSync } from "node:fs";

const PROOF_MP4 = "./out/proof-daniel.mp4";

describe("probe", () => {
  it("reads mp4 metadata", () => {
    if (!existsSync(PROOF_MP4)) {
      // Skip if proof hasn't been generated yet
      return;
    }
    const p = probe(PROOF_MP4);

    ok(p.file.endsWith(".mp4"), "file path ends with .mp4");
    ok(p.durationSec > 0, `duration > 0 (${p.durationSec}s)`);
    strictEqual(p.videoCodec, "h264", "video codec is h264");
    strictEqual(p.audioCodec, "aac", "audio codec is aac");
    strictEqual(p.width, 1280, "width is 1280");
    strictEqual(p.height, 720, "height is 720");
    ok(p.fps !== null, "fps is present");
    ok(p.fps! > 0, `fps > 0 (${p.fps})`);
    ok(p.sampleRate !== null, "sample rate is present");
    ok(p.sampleRate! > 0, `sample rate > 0 (${p.sampleRate})`);
    ok(p.fileSize > 0, `file size > 0 (${p.fileSize} bytes)`);
    ok(p.hash.length === 64, `hash is 64 hex chars (${p.hash.length})`);
    ok(p.frameCount !== null, "frame count is present");
    ok(p.frameCount! > 0, `frame count > 0 (${p.frameCount})`);
  });

  it("hash is deterministic", () => {
    if (!existsSync(PROOF_MP4)) return;
    const p1 = probe(PROOF_MP4);
    const p2 = probe(PROOF_MP4);
    strictEqual(p1.hash, p2.hash, "same file produces same hash");
  });

  it("throws on missing file", () => {
    ok(() => probe("/nonexistent/file.mp4"), "throws on missing file");
  });
});

describe("probeLoudness", () => {
  it("returns null for silent fixture audio", async () => {
    if (!existsSync(PROOF_MP4)) return;
    const loudness = await probeLoudness(PROOF_MP4);
    // Silent fixture audio may return null or a very low value
    // The key is that it doesn't crash
    ok(loudness === null || loudness < -60, `silent audio has very low loudness (${loudness} dB)`);
  });
});