/**
 * Fixture alignment provider — deterministic energy+grapheme fallback.
 *
 * Wraps `src/providers/fallbackVisemes.ts` behind the {@link AlignmentProvider}
 * contract. Used when Rhubarb isn't installed or when running structural proofs
 * that require deterministic, reproducible output.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { probeDuration } from "../providers/ffmpeg.js";
import { generateFallbackTrack } from "../providers/fallbackVisemes.js";
import {
  type AlignmentProvider,
  type AlignmentInput,
  type AlignmentResult,
} from "./types.js";
import type { LipSyncAudio } from "../lipsync/types.js";

export class FixtureAlignmentProvider implements AlignmentProvider {
  readonly id = "fixture";

  async align(input: AlignmentInput): Promise<AlignmentResult> {
    // Trust the caller's durationSec when valid; re-probe only as safety net.
    let durationSec = input.durationSec;
    if (!isFinite(durationSec) || durationSec <= 0) {
      durationSec = await probeDuration(input.audioPath);
    }
    if (!isFinite(durationSec) || durationSec <= 0) {
      throw new Error(
        `Fixture provider: invalid duration ${durationSec}s for ${input.audioPath}`
      );
    }

    // Compute SHA-256 of the audio file
    const sha256 = createHash("sha256")
      .update(readFileSync(input.audioPath))
      .digest("hex");

    const audio: LipSyncAudio = {
      path: input.audioPath,
      sha256,
      durationSec,
      sampleRate: 48000,
      channels: 1,
    };

    const track = generateFallbackTrack({
      trackId: input.trackId,
      utteranceId: input.utteranceId,
      speakerId: input.speakerId,
      text: input.text,
      wavPath: input.audioPath,
      durationSec,
      audio,
    });

    return { track, provider: this.id, fellBack: false };
  }
}