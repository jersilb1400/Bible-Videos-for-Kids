/**
 * Alignment provider contract tests.
 *
 * Verifies the AlignmentProvider contract, QA validation, and the
 * integration between analyze.ts and the provider chain.
 */
import { describe, test } from "node:test";
import * as assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixtureAlignmentProvider } from "../src/alignment/fixture.js";
import { validateTrackQA, validateOffSpeakerAtRest } from "../src/alignment/qa.js";
import { getFixtureProvider, getProviders, analyzeUtterance } from "../src/lipsync/analyze.js";
import type { LipSyncTrack } from "../src/lipsync/types.js";

// Helpers — tiny deterministic PCM fixtures (from visemes.test.ts patterns).
// ---------------------------------------------------------------------------

/** Build a mono 48kHz 16-bit LE PCM buffer. */
function makePcm(
  durationSec: number,
  fn: (t: number) => number = () => 0,
): Buffer {
  const sampleRate = 48000;
  const total = Math.floor(durationSec * sampleRate);
  const buf = Buffer.alloc(total * 2);
  for (let i = 0; i < total; i++) {
    const t = i / sampleRate;
    let s = fn(t);
    if (s > 1) s = 1;
    if (s < -1) s = -1;
    buf.writeInt16LE(Math.round(s * 32767), i * 2);
  }
  return buf;
}

/** 44-byte minimal RIFF WAV wrapper. */
function wrapWav(pcm: Buffer, sampleRate = 48000): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Write a WAV to a temp dir, return the path. */
const testDir = mkdtempSync(join(tmpdir(), "alignment-test-"));
const fs = await import("node:fs");
function writeTempWav(name: string, pcm: Buffer): string {
  const path = join(testDir, name);
  fs.writeFileSync(path, wrapWav(pcm));
  return path;
}

// ---------------------------------------------------------------------------
// Provider contract
// ---------------------------------------------------------------------------

describe("AlignmentProvider contract", () => {
  test("FixtureAlignmentProvider has required fields", async () => {
    const provider = new FixtureAlignmentProvider();
    assert.equal(provider.id, "fixture");
    assert.ok(typeof provider.align === "function");
  });

  test("FixtureAlignmentProvider aligns silence → all X track", async () => {
    const provider = new FixtureAlignmentProvider();
    const wavPath = await writeTempWav("silence.wav", makePcm(2.0, () => 0));

    const result = await provider.align({
      trackId: "track-silence",
      utteranceId: "utt-silence",
      speakerId: "narrator",
      text: "...",
      audioPath: wavPath,
      durationSec: 2.0,
    });

    assert.equal(result.provider, "fixture");
    assert.equal(result.fellBack, false);
    assert.ok(result.track.cues.length > 0, "should have at least one cue");

    // Pure silence → all X shapes
    for (const cue of result.track.cues) {
      assert.equal(cue.shape, "X", "silent audio produces X cues");
    }

    // Track metadata is correct
    assert.equal(result.track.trackId, "track-silence");
    assert.equal(result.track.utteranceId, "utt-silence");
    assert.equal(result.track.speakerId, "narrator");
    assert.equal(result.track.audio.durationSec, 2.0);
  });

  test("FixtureAlignmentProvider produces speech cues for tone bursts", async () => {
    const provider = new FixtureAlignmentProvider();
    // Tone bursts at 0.5-1.5s
    const wavPath = await writeTempWav("speech.wav", makePcm(3.0, (t) => {
      if (t >= 0.5 && t < 1.5) return 0.5 * Math.sin(2 * Math.PI * 440 * t);
      return 0;
    }));

    const result = await provider.align({
      trackId: "track-speech",
      utteranceId: "utt-speech",
      speakerId: "daniel",
      text: "Hello there friend",
      audioPath: wavPath,
      durationSec: 3.0,
    });

    // Should have non-X cues in the active region
    const nonXCues = result.track.cues.filter((c) => c.shape !== "X");
    assert.ok(nonXCues.length > 0, "should detect speech regions");

    // Non-X cues should fall within the active region [0.5, 1.5]
    for (const cue of nonXCues) {
      assert.ok(cue.startSec >= 0.4, `cue ${cue.startSec}s should be near active region`);
      assert.ok(cue.endSec <= 1.6, `cue ${cue.endSec}s should be near active region`);
    }
  });

  test("FixtureAlignmentProvider is deterministic", async () => {
    const provider = new FixtureAlignmentProvider();
    const wavPath = await writeTempWav("determinism.wav", makePcm(2.0, (t) => {
      if (t >= 0.3 && t < 1.2) return 0.3 * Math.sin(2 * Math.PI * 300 * t);
      return 0;
    }));

    const input = {
      trackId: "track-det",
      utteranceId: "utt-det",
      speakerId: "daniel",
      text: "Testing determinism",
      audioPath: wavPath,
      durationSec: 2.0,
    };

    const result1 = await provider.align(input);
    const result2 = await provider.align(input);

    assert.deepStrictEqual(
      result1.track.cues,
      result2.track.cues,
      "same input must produce identical cues",
    );
    assert.equal(result1.track.audio.sha256, result2.track.audio.sha256);
  });
});

// ---------------------------------------------------------------------------
// QA validation
// ---------------------------------------------------------------------------

describe("validateTrackQA", () => {
  function makeTrack(overrides: Partial<LipSyncTrack> = {}): LipSyncTrack {
    return {
      schemaVersion: 1,
      trackId: "t-1",
      utteranceId: "u-1",
      speakerId: "daniel",
      audio: {
        path: "/tmp/x.wav",
        sha256: "abc",
        durationSec: 2.0,
        sampleRate: 48000,
        channels: 1,
      },
      analyzer: { kind: "energy-text-v1" },
      cues: [
        { startSec: 0, endSec: 1.0, shape: "A" },
        { startSec: 1.0, endSec: 2.0, shape: "X" },
      ],
      ...overrides,
    };
  }

  test("passes a valid contiguous track", () => {
    const result = validateTrackQA(makeTrack());
    assert.ok(result.passed, `should pass: ${result.issues.join("; ")}`);
  });

  test("rejects empty cue list (structural validator catches this)", () => {
    const result = validateTrackQA(makeTrack({ cues: [] }));
    assert.ok(!result.passed);
  });

  test("rejects a track with only 1 cue that doesn't fill duration", () => {
    // A single cue [0, 1.0] when duration is 2.0 — structural validator
    // requires the last cue to end at durationSec.
    const result = validateTrackQA(makeTrack({
      cues: [{ startSec: 0, endSec: 1.0, shape: "A" }],
    }));
    assert.ok(!result.passed);
  });

  test("QA passes when structural checks are satisfied", () => {
    // Valid track with multiple cues — structural + QA both pass.
    const result = validateTrackQA(makeTrack({
      cues: [
        { startSec: 0, endSec: 0.5, shape: "A" },
        { startSec: 0.5, endSec: 1.5, shape: "B" },
        { startSec: 1.5, endSec: 2.0, shape: "X" },
      ],
    }));
    assert.ok(result.passed);
  });
});

// ---------------------------------------------------------------------------
// Off-speaker at rest
// ---------------------------------------------------------------------------

describe("validateOffSpeakerAtRest", () => {
  function makeTrack(speaker: string, cues: LipSyncTrack["cues"]): LipSyncTrack {
    return {
      schemaVersion: 1,
      trackId: `track-${speaker}`,
      utteranceId: `utt-${speaker}`,
      speakerId: speaker,
      audio: {
        path: `/tmp/${speaker}.wav`,
        sha256: "abc",
        durationSec: 5.0,
        sampleRate: 48000,
        channels: 1,
      },
      analyzer: { kind: "energy-text-v1" },
      cues,
    };
  }

  test("passes when off-speaker is at rest during overlap", () => {
    const track = makeTrack("other", [
      { startSec: 0, endSec: 5.0, shape: "X" },
    ]);
    const result = validateOffSpeakerAtRest(track, [
      { start: 1.0, end: 4.0 },
    ]);
    assert.ok(result.passed);
  });

  test("rejects when off-speaker moves during overlap", () => {
    const track = makeTrack("other", [
      { startSec: 0, endSec: 2.5, shape: "A" }, // overlaps [1.0, 4.0]
      { startSec: 2.5, endSec: 5.0, shape: "X" },
    ]);
    const result = validateOffSpeakerAtRest(track, [
      { start: 1.0, end: 4.0 },
    ]);
    assert.ok(!result.passed);
    assert.ok(result.issues.some((i) => i.includes("A")));
  });

  test("passes when off-speaker is silent during all overlaps", () => {
    const track = makeTrack("other", [
      { startSec: 0, endSec: 0.5, shape: "B" }, // before overlap
      { startSec: 0.5, endSec: 3.5, shape: "X" }, // covers [1,3] and [2.5,4]
      { startSec: 3.5, endSec: 5.0, shape: "X" }, // after first overlap
    ]);
    const result = validateOffSpeakerAtRest(track, [
      { start: 1.0, end: 3.0 },
      { start: 2.5, end: 4.0 },
    ]);
    assert.ok(result.passed);
  });
});

// ---------------------------------------------------------------------------
// analyzeUtterance integration
// ---------------------------------------------------------------------------

describe("analyzeUtterance (pipeline-facing API)", () => {
  test("returns a LipSyncTrack with correct metadata", async () => {
    const wavPath = await writeTempWav("integration.wav", makePcm(2.0, (t) => {
      if (t >= 0.2 && t < 1.5) return 0.4 * Math.sin(2 * Math.PI * 350 * t);
      return 0;
    }));

    const track = await analyzeUtterance({
      utteranceId: "utt-integration",
      speakerId: "daniel",
      text: "Hello world",
      audioPath: wavPath,
    });

    assert.equal(track.utteranceId, "utt-integration");
    assert.equal(track.speakerId, "daniel");
    assert.ok(track.audio.durationSec > 0);
    assert.ok(track.cues.length > 0);
  });

  test("mode parameter is ignored (auto fallback is always used)", async () => {
    const wavPath = await writeTempWav("mode.wav", makePcm(1.0, () => 0));

    // Should not throw with any mode value
    await analyzeUtterance({
      utteranceId: "utt-mode",
      speakerId: "narrator",
      text: "...",
      audioPath: wavPath,
      mode: "rhubarb", // should fall back gracefully
    });
    assert.ok(true);
  });

  test("fallback produces speech cues for actual audio content", async () => {
    const wavPath = await writeTempWav("speech2.wav", makePcm(2.0, (t) => {
      if (t >= 0.1 && t < 1.8) return 0.3 * Math.sin(2 * Math.PI * 440 * t);
      return 0;
    }));

    const track = await analyzeUtterance({
      utteranceId: "utt-speech",
      speakerId: "daniel",
      text: "Hello world test",
      audioPath: wavPath,
    });

    // Should have non-X cues (speech detected)
    const nonXCues = track.cues.filter((c) => c.shape !== "X");
    assert.ok(nonXCues.length > 0, "should detect speech and produce viseme cues");
  });
});

// ---------------------------------------------------------------------------
// Provider chain
// ---------------------------------------------------------------------------

describe("getProviders", () => {
  test("returns at least two providers", () => {
    const providers = getProviders();
    assert.ok(providers.length >= 2);
  });

  test("first provider is rhubarb, second is fixture", () => {
    const providers = getProviders();
    assert.equal(providers[0]!.id, "rhubarb");
    assert.equal(providers[1]!.id, "fixture");
  });
});

describe("getFixtureProvider", () => {
  test("returns a fixture provider", () => {
    const provider = getFixtureProvider();
    assert.equal(provider.id, "fixture");
  });
});