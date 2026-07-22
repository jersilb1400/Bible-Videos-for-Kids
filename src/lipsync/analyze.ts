import type { LipSyncTrack, MouthCue } from "./types.js";
import type { MouthShape } from "../types.js";

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
  // Read the audio file and generate a basic lip-sync track
  const { readFileSync, statSync } = await import("node:fs");
  const { createHash } = await import("node:crypto");

  const audioData = readFileSync(opts.audioPath);
  const sha256 = createHash("sha256").update(audioData).digest("hex");
  const stat = statSync(opts.audioPath);

  // Estimate duration from file size (16-bit mono 48kHz)
  // WAV header is 44 bytes, rest is 2 bytes per sample
  const dataSize = audioData.length - 44;
  const sampleRate = 48000;
  const durationSec = dataSize > 0 ? dataSize / (sampleRate * 2) : 1.0;

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
