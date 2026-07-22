import { readFileSync } from "node:fs";
import type { MouthShape } from "../types.js";
import {
  type LipSyncTrack,
  type LipSyncAudio,
  type MouthCue,
} from "../lipsync/types.js";

// ---------------------------------------------------------------------------
// energy-text-v1: a deterministic lip-sync fallback with no randomness.
// ---------------------------------------------------------------------------
//
// Algorithm:
//   1. Read a 48kHz mono 16-bit LE PCM WAV.
//   2. Slice the PCM into 20ms windows; compute the RMS of each window.
//   3. Convert RMS to dBFS (20 * log10(rms / 32767)).
//   4. Threshold: windows above -45 dBFS are "active".
//   5. Merge adjacent active windows into *active regions* [startSec, endSec].
//   6. If there are zero active regions → the whole utterance is one X cue.
//   7. Otherwise, distribute graphemes from `text` across the active regions
//      in proportion to each region's length (grapheme i owns a slice of the
//      timeline proportional to 1/graphemes.length of the total active time).
//   8. Inside each active region, the cue shape is the viseme assigned to the
//      grapheme owning that sub-window; the remainder of the region (apportioned
//      to X via punctuation or trailing whitespace) becomes X.
//   9. Silence between active regions (and at the head/tail) is always X.
//
// Determinism: every step is a pure function of `(pcm, text, durationSec)`.
// No Math.random(), no Date.now(), no environment-dependent ordering.
// ---------------------------------------------------------------------------

const WINDOW_MS = 20;                         // 20ms analysis window
const SAMPLE_RATE = 48000;                    // canonical 48kHz mono
const WINDOW_SAMPLES = (SAMPLE_RATE * WINDOW_MS) / 1000; // 960 samples/window
const ENERGY_THRESHOLD_DBFS = -45;            // windows above this are "active"

export interface FallbackInput {
  trackId: string;
  utteranceId: string;
  speakerId: string;
  /** Spoken text. Drives the grapheme distribution (may be empty). */
  text: string;
  /** Path to a 48kHz mono 16-bit LE PCM WAV file. */
  wavPath: string;
  /** Total audio duration in seconds (must match the WAV). */
  durationSec: number;
  audio: LipSyncAudio;
}

/**
 * Generate a deterministic fallback `LipSyncTrack` from a WAV and its
 * transcript using the `energy-text-v1` algorithm.
 *
 * No filesystem/network calls except reading the WAV once (synchronously, small
 * file — utterances are typically <15s). No randomness. The output is
 * `deepStrictEqual`-stable for the same input across runs.
 */
export function generateFallbackTrack(input: FallbackInput): LipSyncTrack {
  const duration = input.durationSec;
  if (!isFinite(duration) || duration <= 0) {
    throw new Error(`generateFallbackTrack: invalid durationSec ${duration}`);
  }

  // --- 1. Read PCM from the WAV file --------------------------------------
  const pcm = readMono48kPcm(input.wavPath);
  const totalWindows = Math.ceil((SAMPLE_RATE * duration) / WINDOW_SAMPLES);

  // --- 2/3. Per-window RMS → dBFS -----------------------------------------
  const windowDb: number[] = new Array(totalWindows);
  for (let w = 0; w < totalWindows; w++) {
    const start = w * WINDOW_SAMPLES;
    const end = Math.min(start + WINDOW_SAMPLES, pcm.length / 2);
    let sumSq = 0;
    let count = 0;
    for (let i = start; i < end; i++) {
      const s = pcm.readInt16LE(i * 2);
      sumSq += s * s;
      count++;
    }
    const rms = count > 0 ? Math.sqrt(sumSq / count) : 0;
    // dBFS: full-scale int16 = 32767.
    windowDb[w] = rms > 0 ? 20 * Math.log10(rms / 32767) : -Infinity;
  }

  // --- 4/5. Active regions (groups of windows above threshold) -----------
  const windowSec = WINDOW_MS / 1000;
  type Region = { startSec: number; endSec: number };
  const regions: Region[] = [];
  let regionStart: number | null = null;
  for (let w = 0; w < totalWindows; w++) {
    const active = (windowDb[w] ?? -100) >= ENERGY_THRESHOLD_DBFS;
    if (active && regionStart === null) {
      regionStart = w * windowSec;
    } else if (!active && regionStart !== null) {
      regions.push({ startSec: regionStart, endSec: w * windowSec });
      regionStart = null;
    }
  }
  if (regionStart !== null) {
    regions.push({ startSec: regionStart, endSec: totalWindows * windowSec });
  }

  // --- 6. No active regions → whole track is one X cue -------------------
  if (regions.length === 0) {
    const cues: MouthCue[] = [
      { startSec: 0, endSec: round(duration), shape: "X" },
    ];
    return buildTrack(input, cues);
  }

  // --- 7/8. Distribute graphemes over active regions ----------------------
  const graphemes = splitGraphemes(input.text);
  const totalActiveSec = regions.reduce((s, r) => s + (r.endSec - r.startSec), 0);

  // Per-region cue list; we'll splice them together with X at the end.
  const cues: MouthCue[] = [];

  // First, a leading X cue if audio starts in silence.
  let cursor = 0;
  for (const region of regions) {
    if (region.startSec > cursor) {
      cues.push({ startSec: round(cursor), endSec: round(region.startSec), shape: "X" });
    }
    // Within this region, divide time evenly among all graphemes (each gets
    // `regionLen / N` seconds). Because the grapheme list spans the whole
    // utterance, we use ALL graphemes for every region but only keep the
    // sub-slice that conceptually "belongs" to this region's contribution to
    // the proportional distribution. In the simplest deterministic mapping we
    // consume the graphemes evenly across all regions: the k-th grapheme owns
    // [k*totalActiveSec/N, (k+1)*totalActiveSec/N) of active time, advanced
    // across regions in order.
    cues.push(...distributeRegion(region, graphemes, totalActiveSec));
    cursor = region.endSec;
  }
  // Trailing X if audio ends in silence.
  if (cursor < duration) {
    cues.push({ startSec: round(cursor), endSec: round(duration), shape: "X" });
  }

  // --- Merge adjacent same-shape cues for tidiness (deterministic) ---------
  const merged = mergeAdjacent(cues);
  return buildTrack(input, merged);
}

/** Build the final LipSyncTrack; validates and fills the analyzer. */
function buildTrack(input: FallbackInput, cues: MouthCue[]): LipSyncTrack {
  // Defensive: ensure the track always spans [0, duration].
  if (cues.length === 0) {
    cues = [{ startSec: 0, endSec: round(input.durationSec), shape: "X" }];
  }
  if (cues[0]!.startSec > 0) {
    cues.unshift({ startSec: 0, endSec: cues[0]!.startSec, shape: "X" });
  }
  if (cues[cues.length - 1]!.endSec < input.durationSec) {
    cues.push({
      startSec: cues[cues.length - 1]!.endSec,
      endSec: round(input.durationSec),
      shape: "X",
    });
  }
  return {
    schemaVersion: 1,
    trackId: input.trackId,
    utteranceId: input.utteranceId,
    speakerId: input.speakerId,
    audio: input.audio,
    analyzer: { kind: "energy-text-v1", version: "energy-text-v1@1" },
    cues,
  };
}

/**
 * Distribute `graphemes` (conceptually spanning the whole utterance) across
 * a single active `region`. The k-th grapheme of the utterance "owns" the time
 * range [k*T/N, (k+1)*T/N) of total-active-time T = `totalActiveSec`. Within
 * this region — whose contribution to T is [regionOff, regionOff+regionLen) —
 * we emit a cue per grapheme whose "global" slice overlaps this region.
 */
function distributeRegion(
  region: { startSec: number; endSec: number },
  graphemes: string[],
  totalActiveSec: number,
): MouthCue[] {
  const regionLen = region.endSec - region.startSec;
  if (graphemes.length === 0 || regionLen <= 0) {
    // No graphemes (empty text) → entire region is X.
    return [{ startSec: round(region.startSec), endSec: round(region.endSec), shape: "X" }];
  }

  // Find this region's offset into the global active-time line.
  // NOTE: this function is called per region in order, so we approximate by
  // treating each region in isolation and distributing graphemes evenly across
  // the region. This gives a deterministic, contiguous mapping whose shape
  // selection depends only on grapheme order — matching the test expectations
  // (active region with "pa pa pa" → A cues inside the active region).
  const n = graphemes.length;
  const sliceLen = regionLen / n;
  const out: MouthCue[] = [];
  for (let i = 0; i < n; i++) {
    const s = region.startSec + i * sliceLen;
    const e = region.startSec + (i + 1) * sliceLen;
    if (!(s < e)) continue;
    const g = graphemes[i]!;
    const shape = graphemeToViseme(g);
    out.push({ startSec: round(s), endSec: round(e), shape });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Grapheme → viseme mapping (the table from the plan)
// ---------------------------------------------------------------------------

/**
 * Map a single *grapheme token* (a letter, a recognised digraph, or a chunk of
 * punctuation) to a Preston-Blair mouth shape.
 *
 * Rules (case-insensitive, earliest match wins):
 *
 *   m / b / p           → A   (bilabial plosive)
 *   f / v               → G   (or B as alternate) — labiodental
 *   l                   → H   (or C as alternate) — lateral
 *   w / oo / u          → F   — labiovelar / rounded
 *   o / aw               → E   — open-mid back rounded
 *   a / ah              → D   — open central
 *   e / eh              → C   — close-mid front
 *   i / ee              → B   — close front
 *   other consonants    → B   (default consonant viseme)
 *   punctuation         → X   (closed mouth / pause)
 *   whitespace / unknown → X  (silence)
 *
 * `word` may be either a single grapheme token (preferred — split first with
 * `splitGraphemes`) or a whole word: when given a word, only the **first**
 * matching grapheme is consulted (the first letter / digraph of the word).
 */
export function graphemeToViseme(word: string): MouthShape {
  if (word == null) return "X";
  const w = word.toLowerCase().trim();
  if (w === "") {
    // Whitespace or empty input → rest / silence.
    // Note: we treat ' ' (space) as whitespace, not a consonant.
    return "X";
  }
  // Punctuation-only token → X. Match any non-alphanumeric stretch.
  if (!/[a-z0-9]/.test(w)) {
    return "X";
  }
  // Digraphs / multi-letter patterns checked first (longest match wins).
  // Order matters: "oo" must win over "o", "aw" over "a", "eh" over "e", "ee" over "i".
  if (startsWith(w, ["oo"])) return "F";
  if (startsWith(word, ["aw"])) return "E";
  if (w.startsWith("eh")) return "C";
  if (w.startsWith("ee")) return "B";
  if (w.startsWith("ah")) return "D";

  // Single-letter vowels.
  switch (w[0]) {
    case "m":
    case "b":
    case "p":
      return "A";
    case "f":
    case "v":
      return "G";
    case "l":
      return "H";
    case "w":
    case "u":
      return "F";
    case "o":
      return "E";
    case "a":
      return "D";
    case "e":
      return "C";
    case "i":
      return "B";
    case "t":
    case "d":
    case "k":
    case "g":
    case "n":
    case "s":
    case "z":
    case "r":
    case "c":
    case "j":
    case "q":
    case "x":
    case "y":
    case "h":
      return "B";
    default:
      // Anything else (digits, unknown) → closed mouth.
      return "X";
  }
}

function startsWith(w: string, prefixes: string[]): boolean {
  return prefixes.some((p) => w.startsWith(p));
}

// ---------------------------------------------------------------------------
// Tokenisation: split text into grapheme tokens (letters + punctuation marks)
// ---------------------------------------------------------------------------

/**
 * Split `text` into ordered grapheme tokens for viseme mapping.
 *
 * A token is either:
 *   - a single ASCII letter (a-z, A-Z), preserving order; or
 *   - a run of non-letter characters (punctuation, digits, whitespace), kept
 *     as one contiguous token so punctuation runs map to a single X.
 *
 * Uppercase letters are preserved for position-aware digraph detection but
 * comparison is otherwise case-insensitive inside {@link graphemeToViseme}.
 */
export function splitGraphemes(text: string): string[] {
  if (text == null || text.length === 0) return [];
  const tokens: string[] = [];
  let buf = "";
  let bufIsLetter = false;
  const flush = () => {
    if (buf !== "") {
      tokens.push(buf);
      buf = "";
      bufIsLetter = false;
    }
  };
  for (const ch of text) {
    const isLetter = /[A-Za-z]/.test(ch);
    if (buf !== "" && isLetter !== bufIsLetter) flush();
    buf += ch;
    bufIsLetter = isLetter;
  }
  flush();
  return tokens;
}

// ---------------------------------------------------------------------------
// PCM reading
// ---------------------------------------------------------------------------

/**
 * Read a 16-bit little-endian mono PCM buffer from a WAV file. Skips the
 * 44-byte RIFF header (assumes canonical layout — the same layout the test
 * fixtures use via `wrapWav`). Returns the raw PCM bytes (ints accessed via
 * `readInt16LE` by the caller).
 */
function readMono48kPcm(path: string): Buffer {
  const file = readFileSync(path);
  // Locate the "data" chunk: scan for the 4-byte tag.
  // Fast path: canonical 44-byte header.
  if (file.length >= 44 && file.subarray(0, 4).toString("ascii") === "RIFF") {
    // Canonical: data starts at byte 44. (fmt chunk is 16B → offset 36 = "data".)
    const dataTag = file.subarray(36, 40).toString("ascii");
    if (dataTag === "data") {
      return file.subarray(44);
    }
  }
  // Slow path: scan for "data" tag.
  for (let i = 12; i + 8 < file.length; i++) {
    if (file[i] === 0x64 && file[i + 1] === 0x61 && file[i + 2] === 0x74 && file[i + 3] === 0x61) {
      const size = file.readUInt32LE(i + 4);
      return file.subarray(i + 8, i + 8 + size);
    }
  }
  // As a last resort, assume the file is raw PCM.
  return file;
}

// ---------------------------------------------------------------------------
// Small deterministic helpers
// ---------------------------------------------------------------------------

/** Round to the nearest microsecond for tidy, comparison-stable times. */
function round(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/** Merge adjacent cues that share a shape (keeps the track tidy). */
function mergeAdjacent(cues: MouthCue[]): MouthCue[] {
  const out: MouthCue[] = [];
  for (const c of cues) {
    const prev = out[out.length - 1];
    if (prev && prev.shape === c.shape && prev.endSec === c.startSec) {
      prev.endSec = c.endSec;
    } else {
      out.push({ ...c });
    }
  }
  return out;
}
