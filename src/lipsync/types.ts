import type { MouthShape } from "../types.js";

/**
 * Canonical lip-sync cue: a half-open time interval [startSec, endSec)
 * mapped to a single Preston-Blair mouth viseme.
 *
 * `startSec` is inclusive, `endSec` is exclusive — the downstream renderer
 * selects the cue whose interval contains the current frame time, so cues in
 * a track must be contiguous and ordered, with no overlap and no gap.
 */
export interface MouthCue {
  startSec: number;
  endSec: number;
  shape: MouthShape;
}

/**
 * The lip-sync analyzer that produced the cue list.
 *
 * - `rhubarb`        — produced by Rhubarb Lip Sync (preferred when available)
 * - `energy-text-v1` — deterministic RMS-energy + grapheme fallback
 * - `rest`           — produces a single X (closed mouth) cue, used when
 *                      lip-sync is disabled or audio is unobtainable
 */
export type LipSyncAnalyzerKind = "rhubarb" | "energy-text-v1" | "rest";

export interface LipSyncAnalyzer {
  kind: LipSyncAnalyzerKind;
  /** Tool version (e.g. Rhubarb "1.13.0") or algorithm tag (e.g. "energy-text-v1@1"). */
  version?: string;
  /** Freeform notes (e.g. "fallback: rhubarb not found on PATH"). */
  notes?: string;
}

/** Audio the track was synthesised from. */
export interface LipSyncAudio {
  path: string;
  /** SHA-256 of the normalised audio file (used as a cache key). */
  sha256: string;
  durationSec: number;
  sampleRate: 48000;
  channels: 1;
}

/**
 * Canonical lip-sync track — the hand-off surface between the lip-sync stage
 * and the renderer. The track is *complete*: its cue list spans the whole
 * utterance from 0 to `audio.durationSec`, so the renderer never has to guess
 * a mouth shape.
 *
 * Invariants (enforced by {@link validateLipSyncTrack}):
 *  1. `schemaVersion` is 1.
 *  2. `cues` is non-empty.
 *  3. The first cue starts at 0.
 *  4. The last cue ends at exactly `audio.durationSec`.
 *  5. Cues are strictly ordered by `startSec` and **contiguous**: each cue's
 *     `endSec` equals the next cue's `startSec` (half-open intervals, no gaps,
 *     no overlaps).
 *  6. Every cue has `startSec < endSec` (no zero-width cues).
 */
export interface LipSyncTrack {
  schemaVersion: 1;
  trackId: string;
  utteranceId: string;
  speakerId: string;
  audio: LipSyncAudio;
  analyzer: LipSyncAnalyzer;
  cues: MouthCue[];
}

/**
 * Validate that a {@link LipSyncTrack} satisfies the canonical invariants.
 *
 * @throws Error with a descriptive message when an invariant is violated. This
 *         is a runtime guard, not a Zod parse — the track is expected to come
 *         from our own pipeline stages (Rhubarb adapter, fallback generator)
 *         and is therefore trusted on shape, but never trusted on invariants.
 *
 * Check ordering is intentional: per-cue shape (positive width, contiguous,
 * ordered) is verified BEFORE boundary alignment so a zero-width cue surfaces
 * with a targeted message rather than the "last cue must end at duration"
 * diagnostic firing first.
 */
export function validateLipSyncTrack(track: LipSyncTrack): void {
  if (track.schemaVersion !== 1) {
    throw new Error(
      `invalid LipSyncTrack: schemaVersion must be 1 (got ${track.schemaVersion})`,
    );
  }
  if (!Array.isArray(track.cues) || track.cues.length === 0) {
    throw new Error("invalid LipSyncTrack: cues must contain at least one entry");
  }
  const duration = track.audio.durationSec;
  const cues = track.cues;
  const first = cues[0]!;
  if (first.startSec !== 0) {
    throw new Error(
      `invalid LipSyncTrack: first cue must start at 0 (got startSec=${first.startSec})`,
    );
  }
  // Per-cue "start < end" and contiguity/ordering are checked FIRST so a
  // zero-width or overlapping cue surfaces with a targeted message (rather
  // than the "last cue must end at duration" check firing first).
  const EPS = 1e-6;
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i]!;
    if (!(c.startSec < c.endSec)) {
      throw new Error(
        `invalid LipSyncTrack: cue ${i} must have positive half-open interval startSec < endSec (got [${c.startSec}, ${c.endSec}))`,
      );
    }
    if (i > 0) {
      const prev = cues[i - 1]!;
      if (Math.abs(prev.endSec - c.startSec) > EPS) {
        throw new Error(
          `invalid LipSyncTrack: cues must be contiguous; cue ${i} startSec=${c.startSec} does not equal cue ${i - 1} endSec=${prev.endSec}`,
        );
      }
      if (c.startSec < prev.startSec) {
        throw new Error(
          `invalid LipSyncTrack: cues must be ordered; cue ${i} startSec=${c.startSec} is earlier than cue ${i - 1} startSec=${prev.startSec}`,
        );
      }
    }
  }
  const last = cues[cues.length - 1]!;
  if (Math.abs(last.endSec - duration) > EPS) {
    throw new Error(
      `invalid LipSyncTrack: last cue must end at audio duration ${duration} (got endSec=${last.endSec})`,
    );
  }
}
