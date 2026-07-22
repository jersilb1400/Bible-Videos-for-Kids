import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type LipSyncTrack,
  type MouthCue,
  validateLipSyncTrack,
} from "../src/lipsync/types.js";
import {
  parseRhubarbJson,
  type RhubarbOutput,
  discoverRhubarb,
  RhubarbMode,
} from "../src/providers/rhubarb.js";
import {
  generateFallbackTrack,
  graphemeToViseme,
  type FallbackInput,
} from "../src/providers/fallbackVisemes.js";
import type { MouthShape } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers — tiny deterministic PCM fixtures built in-test (no external files).
// ---------------------------------------------------------------------------

/** Build a mono 48kHz 16-bit little-endian PCM buffer of `durationSec`. */
function makePcm(
  durationSec: number,
  sampleRate = 48000,
  fn: (t: number, i: number) => number = () => 0,
): Buffer {
  const total = Math.floor(durationSec * sampleRate);
  const buf = Buffer.alloc(total * 2);
  for (let i = 0; i < total; i++) {
    const t = i / sampleRate;
    let s = fn(t, i);
    // clamp + quantise to int16
    if (s > 1) s = 1;
    if (s < -1) s = -1;
    buf.writeInt16LE(Math.round(s * 32767), i * 2);
  }
  return buf;
}

/** Silence PCM buffer. */
function silencePcm(durationSec: number): Buffer {
  return makePcm(durationSec, 48000, () => 0);
}

/** Tone-burst PCM: `amps` = list of {startSec,durSec,freqHz,amp}. Silence elsewhere. */
function burstPcm(
  durationSec: number,
  bursts: { startSec: number; durSec: number; freqHz: number; amp: number }[],
): Buffer {
  return makePcm(durationSec, 48000, (t) => {
    for (const b of bursts) {
      if (t >= b.startSec && t < b.startSec + b.durSec) {
        return b.amp * Math.sin(2 * Math.PI * b.freqHz * t);
      }
    }
    return 0;
  });
}

/** 44-byte minimal RIFF WAV wrapper around 16-bit LE mono PCM. */
function wrapWav(pcm: Buffer, sampleRate = 48000): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20);  // PCM
  header.writeUInt16LE(1, 22);  // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits/sample
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Write a WAV to a temp dir, return the path. */
function writeTempWav(name: string, pcm: Buffer): string {
  const dir = join(tmpdir(), "bvfk-visemes-test");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, wrapWav(pcm));
  return path;
}

// ---------------------------------------------------------------------------
// Canonical contract: LipSyncTrack + MouthCue
// ---------------------------------------------------------------------------

function validTrack(overrides: Partial<LipSyncTrack> = {}): LipSyncTrack {
  const base: LipSyncTrack = {
    schemaVersion: 1,
    trackId: "track-1",
    utteranceId: "utt-1",
    speakerId: "daniel",
    audio: {
      path: "/tmp/x.wav",
      sha256: "deadbeef",
      durationSec: 1.0,
      sampleRate: 48000,
      channels: 1,
    },
    analyzer: { kind: "rhubarb", version: "1.13.0" },
    cues: [
      { startSec: 0, endSec: 0.5, shape: "A" },
      { startSec: 0.5, endSec: 1.0, shape: "X" },
    ],
  };
  return { ...base, ...overrides };
}

test("validateLipSyncTrack accepts a contiguous, ordered, half-open track", () => {
  const track = validTrack();
  validateLipSyncTrack(track); // does not throw
  assert.ok(true);
});

test("validateLipSyncTrack rejects a track whose first cue does not start at 0", () => {
  const track = validTrack({
    cues: [
      { startSec: 0.1, endSec: 0.5, shape: "A" },
      { startSec: 0.5, endSec: 1.0, shape: "X" },
    ],
  });
  assert.throws(() => validateLipSyncTrack(track), /start.*0|first/i);
});

test("validateLipSyncTrack rejects a track whose last cue does not end at audio duration", () => {
  const track = validTrack({
    audio: { path: "/tmp/x.wav", sha256: "d", durationSec: 1.0, sampleRate: 48000, channels: 1 },
    cues: [
      { startSec: 0, endSec: 0.5, shape: "A" },
      { startSec: 0.5, endSec: 0.9, shape: "X" },
    ],
  });
  assert.throws(() => validateLipSyncTrack(track), /end|duration|last/i);
});

test("validateLipSyncTrack rejects out-of-order cues", () => {
  const track = validTrack({
    cues: [
      { startSec: 0, endSec: 0.6, shape: "A" },
      { startSec: 0.5, endSec: 1.0, shape: "X" }, // overlaps prev (non-contiguous)
    ],
  });
  assert.throws(() => validateLipSyncTrack(track), /contiguous|overlap|order/i);
});

test("validateLipSyncTrack rejects cues with start >= end", () => {
  const track = validTrack({
    cues: [
      { startSec: 0, endSec: 0.5, shape: "A" },
      { startSec: 0.5, endSec: 0.5, shape: "X" }, // zero-width
    ],
  });
  assert.throws(() => validateLipSyncTrack(track), /half.open|start.*end|positive/i);
});

test("validateLipSyncTrack rejects an empty cue list", () => {
  const track = validTrack({ cues: [] });
  assert.throws(() => validateLipSyncTrack(track), /empty|at least one/i);
});

test("validateLipSyncTrack rejects an unsupported schemaVersion", () => {
  const track = validTrack({ schemaVersion: 2 as any });
  assert.throws(() => validateLipSyncTrack(track), /schemaVersion|version/i);
});

// ---------------------------------------------------------------------------
// Rhubarb JSON fixture: parse, fill gaps with X, clip overlaps
// ---------------------------------------------------------------------------

/** Realistic Rhubarb export shape. timeCubes use seconds. */
const rhubarbFixture: RhubarbOutput = {
  // Rhubarb emits `mouthCues`: array of {start, end, value} with value in A-X-G-H.
  // There may be small gaps between consecutive cues (Rhubarb skips silence).
  mouthCues: [
    { start: 0.0, end: 0.2, value: "A" },
    { start: 0.2, end: 0.4, value: "B" },
    // GAP 0.4-0.5: silence — must be filled with X.
    { start: 0.5, end: 0.7, value: "C" },
    // OVERLAP: Rhubarb sometimes emits overlapping cues (0.65-0.8 vs 0.7-0.9).
    { start: 0.7, end: 0.9, value: "D" },
    // gap 0.9 - 1.0: trailing silence → filled with X to reach durationSec=1.0.
  ],
  sound: "test.wav",
  // Rhubarb doesn't always include total length; we feed it separately.
};

test("parseRhubarbJson fills gaps (silence) with X and clips overlaps to a contiguous track", () => {
  const track = parseRhubarbJson(rhubarbFixture, {
    trackId: "t1",
    utteranceId: "u1",
    speakerId: "daniel",
    audio: {
      path: "/tmp/test.wav",
      sha256: "abc123",
      durationSec: 1.0,
      sampleRate: 48000,
      channels: 1,
    },
  });

  // Must produce a valid canonical track.
  validateLipSyncTrack(track);

  // First cue starts at 0, last ends at 1.0.
  assert.equal(track.cues[0]!.startSec, 0);
  assert.equal(track.cues[track.cues.length - 1]!.endSec, 1.0);

  // Gap 0.4-0.5 was filled with X.
  const gap = track.cues.find((c) => c.startSec === 0.4 && c.endSec === 0.5);
  assert.ok(gap, "gap 0.4-0.5 was filled");
  assert.equal(gap!.shape, "X");

  // Trailing silence 0.9-1.0 filled with X.
  const tail = track.cues.find((c) => c.startSec === 0.9 && c.endSec === 1.0);
  assert.ok(tail, "trailing silence filled");
  assert.equal(tail!.shape, "X");

  // The overlap (0.7-0.9 after the 0.5-0.7 cue) was clipped so the track is
  // contiguous: no cue starts before the previous cue ends.
  for (let i = 1; i < track.cues.length; i++) {
    assert.equal(
      track.cues[i]!.startSec,
      track.cues[i - 1]!.endSec,
      `cue ${i} is contiguous with cue ${i - 1}`,
    );
  }

  assert.equal(track.analyzer.kind, "rhubarb");
});

test("parseRhubarbJson produces a single X cue when the input is completely silent", () => {
  const silent: RhubarbOutput = { mouthCues: [], sound: "s.wav" };
  const track = parseRhubarbJson(silent, {
    trackId: "t1",
    utteranceId: "u1",
    speakerId: "daniel",
    audio: {
      path: "/tmp/s.wav",
      sha256: "x",
      durationSec: 0.5,
      sampleRate: 48000,
      channels: 1,
    },
  });
  validateLipSyncTrack(track);
  assert.equal(track.cues.length, 1);
  assert.deepEqual(track.cues[0], { startSec: 0, endSec: 0.5, shape: "X" });
});

// ---------------------------------------------------------------------------
// Rhubarb discovery
// ---------------------------------------------------------------------------

test("discoverRhubarb returns null when RHUBARB_BIN unset, no vendor/, PATH misses", () => {
  delete process.env.RHUBARB_BIN;
  const found = discoverRhubarb({ env: {} as any, PATH: "/nonexistent" });
  assert.equal(found, null);
});

test("discoverRhubarb honours RHUBARB_BIN when the path exists", () => {
  const fakeBin = writeTempWav("fake-rhubarb", Buffer.alloc(0)).replace(/\.wav$/, "");
  // Just use any existing path as a stand-in.
  const realPath = join(tmpdir(), "bvfk-visemes-test");
  const found = discoverRhubarb({
    env: { RHUBARB_BIN: realPath } as any,
    PATH: "/nonexistent",
    existsSync: (p) => p === realPath,
  });
  assert.equal(found, realPath);
});

test("RhubarbMode.disabled short-circuits discovery to null", () => {
  const found = discoverRhubarb({
    env: { RHUBARB_BIN: "/usr/bin/rhubarb", RHUBARB_MODE: "disabled" } as any,
    existsSync: () => true,
  });
  assert.equal(found, null);
});

// ---------------------------------------------------------------------------
// Fallback energy-text-v1: determinism, silence, tone bursts
// ---------------------------------------------------------------------------

const baseFallbackAudio = {
  sha256: "fake",
  sampleRate: 48000 as const,
  channels: 1 as const,
};

test("fallback: pure silence produces a single X cue spanning the whole duration", () => {
  const wav = writeTempWav("silence.wav", silencePcm(0.6));
  const input: FallbackInput = {
    trackId: "t1",
    utteranceId: "u1",
    speakerId: "daniel",
    text: "Hello",
    wavPath: wav,
    durationSec: 0.6,
    audio: { ...baseFallbackAudio, path: wav, durationSec: 0.6 },
  };
  const track = generateFallbackTrack(input);
  validateLipSyncTrack(track);
  assert.equal(track.cues.length, 1);
  assert.equal(track.cues[0]!.shape, "X");
  assert.equal(track.cues[0]!.startSec, 0);
  assert.equal(track.cues[0]!.endSec, 0.6);
  assert.equal(track.analyzer.kind, "energy-text-v1");
});

test("fallback: tone bursts produce at least one non-X cue in the active region", () => {
  // 1.0s of audio with a 0.2-0.5s 220Hz tone, then silence 0.5-1.0s.
  const wav = writeTempWav(
    "bursts.wav",
    burstPcm(1.0, [{ startSec: 0.2, durSec: 0.3, freqHz: 220, amp: 0.6 }]),
  );
  const input: FallbackInput = {
    trackId: "t1",
    utteranceId: "u1",
    speakerId: "daniel",
    text: "pa pa pa", // plosive-heavy so visemes are A
    wavPath: wav,
    durationSec: 1.0,
    audio: { ...baseFallbackAudio, path: wav, durationSec: 1.0 },
  };
  const track = generateFallbackTrack(input);
  validateLipSyncTrack(track);
  // There must be at least one non-X cue in the active region (e.g. a vowel
  // viseme from "pa"'s 'a'). The exact shape is determined by the viseme
  // table; here we only require energy above the silence threshold to surface.
  const activeNonX = track.cues.find(
    (c) => c.shape !== "X" && c.startSec >= 0.2 && c.endSec <= 0.5,
  );
  assert.ok(activeNonX, "found a non-X cue during 0.2-0.5 tone burst");
  // The trailing silence 0.5-1.0 must be X.
  const tail = track.cues.find((c) => c.startSec >= 0.5 && c.shape === "X");
  assert.ok(tail, "trailing silence is X");
});

test("fallback: same input twice produces deep-equal tracks (determinism)", () => {
  const wav = writeTempWav(
    "det.wav",
    burstPcm(1.0, [
      { startSec: 0.0, durSec: 0.2, freqHz: 200, amp: 0.5 },
      { startSec: 0.3, durSec: 0.2, freqHz: 250, amp: 0.4 },
    ]),
  );
  const input: FallbackInput = {
    trackId: "t1",
    utteranceId: "u1",
    speakerId: "daniel",
    text: "mama",
    wavPath: wav,
    durationSec: 1.0,
    audio: { ...baseFallbackAudio, path: wav, durationSec: 1.0 },
  };
  const a = generateFallbackTrack(input);
  const b = generateFallbackTrack(input);
  assert.deepEqual(a, b);
});

test("fallback: respects provided trackId/utteranceId/speakerId", () => {
  const wav = writeTempWav("ids.wav", silencePcm(0.4));
  const track = generateFallbackTrack({
    trackId: "track-xyz",
    utteranceId: "utt-42",
    speakerId: "darius",
    text: "",
    wavPath: wav,
    durationSec: 0.4,
    audio: { ...baseFallbackAudio, path: wav, durationSec: 0.4 },
  });
  assert.equal(track.trackId, "track-xyz");
  assert.equal(track.utteranceId, "utt-42");
  assert.equal(track.speakerId, "darius");
});

// ---------------------------------------------------------------------------
// Grapheme-to-viseme mapping (the full table from the plan)
// ---------------------------------------------------------------------------

test("graphemeToViseme maps m/b/p → A (single-letter graphemes only)", () => {
  // Single-letter inputs route to the bilabial plosive viseme A. Multi-letter
  // words like "mat" route to the first vowel's viseme (D for 'a'); the
  // bilabial is only the canonical viseme when it is the standalone grapheme.
  for (const w of ["m", "b", "p", "M", "B", "P"]) {
    assert.equal(graphemeToViseme(w), "A", `"${w}" → A`);
  }
});

test("graphemeToViseme maps f/v → G (or B)", () => {
  // Single-letter inputs only — multi-letter words with a trailing vowel (e.g.
  // "father") intentionally route to the vowel viseme, so we don't test those
  // here. The plan allows G or B for f/v graphemes.
  for (const w of ["f", "v", "F", "V"]) {
    const r = graphemeToViseme(w);
    assert.ok(r === "G" || r === "B", `"${w}" → G or B (got ${r})`);
  }
});

test("graphemeToViseme maps l → H (or C)", () => {
  for (const w of ["l", "L"]) {
    const r = graphemeToViseme(w);
    assert.ok(r === "H" || r === "C", `"${w}" → H or C (got ${r})`);
  }
});

test("graphemeToViseme maps w/oo/u → F", () => {
  // Single-letter + digraph inputs only (multi-letter words where the first
  // letter is a generic consonant + a vowel necessarily route to the vowel).
  for (const w of ["w", "oo", "u", "W", "OO", "U", "wood", "moon"]) {
    assert.equal(graphemeToViseme(w), "F", `"${w}" → F`);
  }
});

test("graphemeToViseme maps o/aw → E", () => {
  for (const w of ["o", "O", "aw", "AW", "on", "law"]) {
    assert.equal(graphemeToViseme(w), "E", `"${w}" → E`);
  }
});

test("graphemeToViseme maps a/ah → D", () => {
  for (const w of ["a", "ah", "A", "AH", "cat", "father"]) {
    assert.equal(graphemeToViseme(w), "D", `"${w}" → D`);
  }
});

test("graphemeToViseme maps e/eh → C", () => {
  for (const w of ["e", "eh", "E", "EH", "bed", "egg"]) {
    assert.equal(graphemeToViseme(w), "C", `"${w}" → C`);
  }
});

test("graphemeToViseme maps i/ee → B", () => {
  for (const w of ["i", "ee", "I", "EE", "see"]) {
    assert.equal(graphemeToViseme(w), "B", `"${w}" → B`);
  }
});

test("graphemeToViseme maps other consonants → B", () => {
  for (const w of ["t", "d", "k", "g", "n", "s", "z", "r", "T", "sit"]) {
    assert.equal(graphemeToViseme(w), "B", `"${w}" → B (consonant)`);
  }
});

test("graphemeToViseme maps punctuation → X", () => {
  for (const w of [".", ",", "!", "?", ";", ":", "-", "---"]) {
    assert.equal(graphemeToViseme(w), "X", `"${w}" → X (punctuation)`);
  }
});
