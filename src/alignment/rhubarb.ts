/**
 * Rhubarb alignment provider — real phoneme-level lip sync.
 *
 * Wraps the existing `src/providers/rhubarb.ts` adapter (discovery, invocation,
 * JSON parsing) behind the {@link AlignmentProvider} contract.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { log } from "../logger.js";
import { ffmpeg, probeDuration } from "../providers/ffmpeg.js";
import {
  discoverRhubarb,
  invokeRhubarb,
  parseRhubarbJson,
  type RhubarbOutput,
} from "../providers/rhubarb.js";
import {
  type AlignmentProvider,
  type AlignmentInput,
  type AlignmentResult,
} from "./types.js";
import type { LipSyncAudio } from "../lipsync/types.js";

export class RhubarbAlignmentProvider implements AlignmentProvider {
  readonly id = "rhubarb";

  async align(input: AlignmentInput): Promise<AlignmentResult> {
    const binPath = discoverRhubarb();
    if (!binPath) {
      throw new Error("Rhubarb binary not found (set RHUBARB_BIN or install to vendor/)");
    }

    // Normalize WAV to mono 48kHz 16-bit
    const normalizedWav = await this.normalizeWav(input.audioPath);

    // Write transcript to temp file for Rhubarb's --dialogFile
    const dir = mkdtempSync(join(tmpdir(), "rhubarb-align-"));
    const transcriptPath = join(dir, "transcript.txt");
    writeFileSync(transcriptPath, input.text);

    try {
      const { output } = await invokeRhubarb({
        binPath,
        wavPath: normalizedWav,
        transcriptPath,
      });

      const audio = this.audioMeta(normalizedWav, input.durationSec);
      const track = parseRhubarbJson(output, {
        trackId: input.trackId,
        utteranceId: input.utteranceId,
        speakerId: input.speakerId,
        audio,
      });

      return { track, provider: this.id, fellBack: false };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Normalize audio to mono 48kHz 16-bit WAV. */
  private async normalizeWav(inputPath: string): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "wav-norm-"));
    const outPath = join(dir, "normalized.wav");

    await ffmpeg([
      "-y", "-i", inputPath,
      "-ac", "1", "-ar", "48000", "-sample_fmt", "s16",
      outPath,
    ]);

    return outPath;
  }

  private audioMeta(wavPath: string, durationSec: number): LipSyncAudio {
    const sha256 = createHash("sha256")
      .update(readFileSync(wavPath))
      .digest("hex");
    return {
      path: wavPath,
      sha256,
      durationSec,
      sampleRate: 48000,
      channels: 1,
    };
  }
}