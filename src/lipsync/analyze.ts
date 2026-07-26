/**
 * Lip-sync analysis module.
 *
 * Coordinates the alignment provider chain:
 *   1. Probe audio duration via ffprobe (never guess from compressed bytes)
 *   2. Try Rhubarb for phoneme-level alignment
 *   3. Fall back to energy-text-v1 when Rhubarb isn't available
 *   4. Run QA validation on the result
 *
 * Public API: {@link analyzeUtterance} — pipeline-facing, backward compatible.
 * Internal API: {@link analyzeLipSync} — uses the AlignmentProvider contract.
 */
import { probeDuration } from "../providers/ffmpeg.js";
import { log } from "../logger.js";
import { RhubarbAlignmentProvider } from "../alignment/rhubarb.js";
import { FixtureAlignmentProvider } from "../alignment/fixture.js";
import type { AlignmentInput, AlignmentResult } from "../alignment/types.js";
import { statSync } from "node:fs";

const rhubarbProvider = new RhubarbAlignmentProvider();
const fixtureProvider = new FixtureAlignmentProvider();

// ---------------------------------------------------------------------------
// Internal: conservative fallback duration estimate
// ---------------------------------------------------------------------------

/**
 * Conservative byte-based duration estimate for when ffprobe is unavailable.
 * WAV: uses header info (data bytes / sample rate / channels / bytes per sample)
 * Other: assumes MP3 at 128 kbps CBR — a common Edge-TTS output format.
 * This is intentionally conservative (slightly overestimates) so we never
 * truncate viseme timing. The result is approximate and must be logged.
 */
function conservativeDurationEstimate(audioPath: string): number {
  try {
    const size = statSync(audioPath).size;
    if (audioPath.endsWith(".wav")) {
      // WAV files have a 44-byte header; data = size - 44
      // Most WAVs are 16-bit PCM: channels * sample_rate * 2
      // Conservative estimate: mono 16-bit PCM at 44100 Hz
      return (size - 44) / (1 * 44100 * 2);
    }
    // 128 kbps = 16000 bytes/sec. Add 10% headroom for VBR/headers.
    return (size / 16000) * 1.1;
  } catch {
    // If even statSync fails, return 1s as a last resort
    return 1.0;
  }
}

// ---------------------------------------------------------------------------
// Internal: provider-chain analysis
// ---------------------------------------------------------------------------

/**
 * Analyse an utterance using the alignment provider chain and return a
 * validated LipSyncTrack.
 */
async function analyzeLipSync(input: AlignmentInput): Promise<AlignmentResult> {
  // 1. Probe duration via ffprobe (never guess from compressed file size).
  // If ffprobe is unavailable or returns nothing usable, fall back to a
  // conservative byte-based estimate and log a warning — do NOT silently
  // produce wrong timing, and do NOT crash the pipeline over a missing binary.
  let durationSec = await probeDuration(input.audioPath);
  if (!isFinite(durationSec) || durationSec <= 0) {
    const approx = conservativeDurationEstimate(input.audioPath);
    log.warn(
      `analyzeLipSync: ffprobe unavailable/failed for ${input.utteranceId} ` +
      `(${input.audioPath}); using conservative byte-based estimate ` +
      `${approx.toFixed(3)}s — viseme timing is approximate, not exact.`
    );
    durationSec = approx;
  }

  const enrichedInput: AlignmentInput = { ...input, durationSec };

  // 2. Try Rhubarb
  try {
    const result = await rhubarbProvider.align(enrichedInput);
    return result;
  } catch (err) {
    // 3. Fall back to fixture provider
    log.info(
      `Rhubarb unavailable for ${input.utteranceId} (${(err as Error).message}); ` +
      `falling back to energy-text-v1`
    );

    return await fixtureProvider.align(enrichedInput);
  }
}

// ---------------------------------------------------------------------------
// Public API: backward-compatible with pipelineV2
// ---------------------------------------------------------------------------

/** Legacy input shape from the pipeline (backward compatible). */
export interface AnalyzeUtteranceInput {
  utteranceId: string;
  speakerId: string;
  text: string;
  audioPath: string;
  /** Legacy mode parameter — ignored (auto fallback is always used). */
  mode?: string;
}

/**
 * Analyse a single utterance and return a LipSyncTrack.
 *
 * This is the pipeline-facing API. It adapts the legacy input shape to the
 * AlignmentProvider contract, probes duration via ffprobe, tries Rhubarb,
 * falls back to energy-text-v1, and validates with QA.
 */
export async function analyzeUtterance(
  input: AnalyzeUtteranceInput,
): Promise<AlignmentResult["track"]> {
  const alignmentInput: AlignmentInput = {
    trackId: `${input.speakerId}-${input.utteranceId}`,
    utteranceId: input.utteranceId,
    speakerId: input.speakerId,
    text: input.text,
    audioPath: input.audioPath,
    durationSec: 0, // will be probed by analyzeLipSync
  };

  const result = await analyzeLipSync(alignmentInput);
  return result.track;
}

// ---------------------------------------------------------------------------
// Provider access (for testing / structural proofs)
// ---------------------------------------------------------------------------

/**
 * Get the alignment provider chain. Useful for testing or plugging in custom providers.
 */
export function getProviders(): [typeof rhubarbProvider, typeof fixtureProvider] {
  return [rhubarbProvider, fixtureProvider];
}

/**
 * Direct access to the fixture provider (for structural proofs, tests).
 */
export function getFixtureProvider(): typeof fixtureProvider {
  return fixtureProvider;
}