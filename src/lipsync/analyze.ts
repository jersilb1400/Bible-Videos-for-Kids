import type { LipSyncTrack, MouthCue } from "./types.js";
import type { MouthShape } from "../types.js";
import { execFile } from "node:child_process";

export interface AnalyzeOptions {
  utteranceId: string;
  speakerId: string;
  text: string;
  audioPath: string;
  mode: "auto" | "required" | "disabled";
}

/**
 * Analyze an utterance audio file and produce a LipSyncTrack.
 * Tries Rhubarb first; falls back to energy-text-v1 if unavailable.
 */
export async function analyzeUtterance(opts: AnalyzeOptions): Promise<LipSyncTrack> {
  // For now, always use the deterministic fallback
  // (Rhubarb integration can be enabled later via rhubarb.ts adapter)
  return fallbackAnalyze(opts);
}

async function fallbackAnalyze(opts: AnalyzeOptions): Promise<LipSyncTrack> {
  const { readFileSync } = await import("node:fs");
  const { createHash } = await import("node:crypto");

  const audioData = readFileSync(opts.audioPath);
  const sha256 = createHash("sha256").update(audioData).digest("hex");

  // Use ffprobe for accurate duration — the old file-size heuristic assumed
  // raw 16-bit PCM at 48kHz, which is wrong for edge-tts MP3/WAV output.
  const durationSec = await probeAudioDuration(opts.audioPath);

  // Simple grapheme-based viseme mapping (proportional distribution)
  const cues = generateFallbackCues(opts.text, durationSec);

  return {
    schemaVersion: 1,
    trackId: `track-${opts.utteranceId}`,
    utteranceId: opts.utteranceId,
    speakerId: opts.speakerId,
    audio: {
      path: opts.audioPath,
      sha256,
      durationSec,
      sampleRate: 48000,
      channels: 1,
    },
    analyzer: {
      kind: "energy-text-v1",
      notes: "fallback: rhubarb not enabled",
    },
    cues,
  };
}

/**
 * Generate fallback viseme cues from text using simple grapheme mapping.
 * Each character gets a proportional slice of the audio duration.
 */
function generateFallbackCues(text: string, durationSec: number): MouthCue[] {
  const chars = text.split("");
  const charDuration = durationSec / Math.max(chars.length, 1);

  const cues: MouthCue[] = [];
  let t = 0;

  for (const char of chars) {
    const shape = graphemeToViseme(char);
    const endSec = t + charDuration;
    cues.push({ startSec: t, endSec, shape });
    t = endSec;
  }

  // Fill any remaining time with rest position
  if (t < durationSec) {
    cues.push({ startSec: t, endSec: durationSec, shape: "X" });
  }

  return cues;
}

function graphemeToViseme(char: string): MouthShape {
  const lower = char.toLowerCase();
  if (/[m|b|p]/.test(lower)) return "A";
  if (/[f|v]/.test(lower)) return "G";
  if (/[l]/.test(lower)) return "H";
  if (/[w|u|o]/.test(lower)) return "F";
  if (/[o]/.test(lower)) return "E";
  if (/[a]/.test(lower)) return "D";
  if (/[e]/.test(lower)) return "C";
  if (/[i]/.test(lower)) return "B";
  if (/[bcdfgjklmnprstvwxz]/.test(lower)) return "B";
  return "X"; // spaces, punctuation, rest
}

/**
 * Probe audio duration in seconds using ffprobe.
 * Works correctly for WAV, MP3, and any format ffprobe supports.
 * Falls back to 1.0s if ffprobe is unavailable.
 */
function probeAudioDuration(filePath: string): Promise<number> {
  return new Promise((pResolve, pReject) => {
    const child = execFile(
      "ffprobe",
      [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        filePath,
      ],
      { timeout: 5_000 },
    );
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on("data", () => { /* swallow */ });
    child.on("close", (code: number | null) => {
      if (code !== 0) {
        // ffprobe failed — fall back to a default rather than crashing the pipeline
        pResolve(1.0);
        return;
      }
      const seconds = parseFloat(stdout.trim());
      if (!Number.isFinite(seconds) || seconds <= 0) {
        pResolve(1.0);
        return;
      }
      pResolve(seconds);
    });
    child.on("error", () => pResolve(1.0));
  });
}
