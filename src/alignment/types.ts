/**
 * AlignmentProvider contract.
 *
 * An alignment provider takes a normalised mono WAV and its transcript and
 * returns a {@link LipSyncTrack} — a contiguous, validated list of mouth-cue
 * timings. The provider abstraction lets the pipeline try Rhubarb first and
 * fall back to a deterministic fixture provider when Rhubarb isn't installed.
 */
import type { LipSyncTrack } from "../lipsync/types.js";

/** Input to an alignment provider. */
export interface AlignmentInput {
  trackId: string;
  utteranceId: string;
  speakerId: string;
  text: string;
  /** Path to a mono WAV file (any sample rate; provider normalises if needed). */
  audioPath: string;
  /** Duration in seconds (probed by ffprobe, never guessed from file size). */
  durationSec: number;
}

/** Result of an alignment run. */
export interface AlignmentResult {
  track: LipSyncTrack;
  /** Which provider produced this track. */
  provider: string;
  /** Whether the provider fell back (e.g. Rhubarb failed → fixture). */
  fellBack: boolean;
}

/**
 * AlignmentProvider — the pluggable contract for lip-sync analysis.
 *
 * Implementations:
 *   - {@link RhubarbAlignmentProvider}  — real phoneme alignment via Rhubarb
 *   - {@link FixtureAlignmentProvider}   — deterministic energy+grapheme fallback
 */
export interface AlignmentProvider {
  /** Provider identifier (e.g. "rhubarb", "fixture"). */
  readonly id: string;

  /**
   * Analyse the audio and return a validated LipSyncTrack.
   * Must throw on hard failure (never return a garbage track).
   */
  align(input: AlignmentInput): Promise<AlignmentResult>;
}
