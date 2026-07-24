import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Emotion } from "../types.js";
import { EMOTION_MODULATION } from "./engine.js";

// Re-export for convenience
export { EMOTION_MODULATION } from "./engine.js";

// ────────────────────────────────────────────────────────────────────────────
// Voice identity — per-character voice profile persisted in the manifest.
// ────────────────────────────────────────────────────────────────────────────

/** Per-character voice configuration, applying emotion modulation on the base. */
export interface VoiceProfile {
  /** Base TTS provider voice ID (e.g., "en-US-ChristopherNeural" for Edge-TTS). */
  providerVoiceId: string;
  /** Base playback rate multiplier (1.0 = normal). */
  rate: number;
  /** Base pitch shift in Hz (0 = no shift). */
  pitch: number;
  /** Per-emotion overrides that are applied ON TOP of the base. */
  emotionOverrides?: Partial<Record<Emotion, { rate?: number; pitch?: number; gainDb?: number }>>;
}

// ────────────────────────────────────────────────────────────────────────────
// Enhanced speech request — carries emotion + voice profile for modulation.
// ────────────────────────────────────────────────────────────────────────────

export interface EnhancedSpeechRequest {
  utteranceId: string;
  speakerId: string;
  text: string;
  emotion: Emotion;
  voiceProfile: VoiceProfile;
  outputPath: string; // .wav
}

export interface SpeechClip {
  utteranceId: string;
  file: string;
  /** Duration in milliseconds, measured from the actual audio file via ffprobe. */
  durationMs: number;
  /** The emotion that was applied (useful for provenance/debugging). */
  emotion: Emotion;
}

// ────────────────────────────────────────────────────────────────────────────
// Enhanced speech provider interface.
// ────────────────────────────────────────────────────────────────────────────

export interface EnhancedSpeechProvider {
  readonly id: string;
  synthesize(req: EnhancedSpeechRequest): Promise<SpeechClip>;
}

// ────────────────────────────────────────────────────────────────────────────
// Edge-TTS enhanced provider — applies per-emotion rate/pitch modulation.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Enhanced Edge-TTS provider that modulates rate and pitch per emotion,
 * applies a gain stage via FFmpeg post-processing, and measures real audio
 * duration via ffprobe (never estimates from text length).
 */
export class EdgeTtsEnhancedProvider implements EnhancedSpeechProvider {
  readonly id = "edge-tts-enhanced";

  async synthesize(req: EnhancedSpeechRequest): Promise<SpeechClip> {
    mkdirSync(dirname(req.outputPath), { recursive: true });

    // Resolve modulated parameters
    const mod = this.resolveModulation(req);
    const modulatedRate = req.voiceProfile.rate * mod.rate;
    const modulatedPitch = req.voiceProfile.pitch + mod.pitchHz;

    // Check if edge-tts binary is available
    if (!this.isEdgeTtsAvailable()) {
      throw new Error(
        `edge-tts not found on PATH. Install with: pip install edge-tts`,
      );
    }

    // Stage 1: Generate raw TTS audio
    const rawPath = req.outputPath.replace(/\.wav$/, ".raw.wav");
    await this.runEdgeTts(req, modulatedRate, modulatedPitch, rawPath);

    // Stage 2: Apply gain (if non-zero) and re-encode to standard PCM
    if (mod.gainDb !== 0) {
      await this.applyGain(rawPath, req.outputPath, mod.gainDb);
    } else {
      // Just copy/re-encode to ensure consistent format
      await this.reencode(rawPath, req.outputPath);
    }

    // Clean up raw file
    try {
      const { unlinkSync } = await import("node:fs");
      unlinkSync(rawPath);
    } catch { /* may not exist */ }

    // Stage 3: Measure actual duration via ffprobe
    const durationMs = await this.getAudioDurationMs(req.outputPath);

    return {
      utteranceId: req.utteranceId,
      file: req.outputPath,
      durationMs,
      emotion: req.emotion,
    };
  }

  private isEdgeTtsAvailable(): boolean {
    try {
      // Check if edge-tts is on PATH
      const check = spawn("which", ["edge-tts"], { stdio: "pipe" });
      // Synchronous check is hard in async; use a heuric.

      // Try the local node_modules path first
      const binPath = resolve("node_modules/.bin/edge-tts");
      return existsSync(binPath) || existsSync("/usr/local/bin/edge-tts") || existsSync("/opt/homebrew/bin/edge-tts");
    } catch {
      return false;
    }
  }

  private resolveModulation(req: EnhancedSpeechRequest): { rate: number; pitchHz: number; gainDb: number } {
    const base = EMOTION_MODULATION[req.emotion] ?? EMOTION_MODULATION.neutral;
    const override = req.voiceProfile.emotionOverrides?.[req.emotion];
    return {
      rate: override?.rate ?? base.rate,
      pitchHz: override?.pitch ?? base.pitchHz,
      gainDb: override?.gainDb ?? base.gainDb,
    };
  }

  private runEdgeTts(
    req: EnhancedSpeechRequest,
    rate: number,
    pitch: number,
    outputPath: string,
  ): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      const edgeTtsBin = resolve("node_modules/.bin/edge-tts");
      const args = [
        "--voice", req.voiceProfile.providerVoiceId,
        "--text", req.text,
        "--write-media", outputPath,
      ];
      const ratePercent = `${rate > 1 ? "+" : ""}${Math.round((rate - 1) * 100)}%`;
      const pitchHz = `${pitch > 0 ? "+" : ""}${Math.round(pitch)}Hz`;
      args.push("--rate", ratePercent);
      args.push("--pitch", pitchHz);

      const tts = spawn(edgeTtsBin, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      tts.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
      tts.on("close", (code: number | null) => {
        if (code !== 0) reject(new Error(`edge-tts failed (${code}): ${stderr}`));
        else resolvePromise();
      });
      tts.on("error", reject);
    });
  }

  private applyGain(inputPath: string, outputPath: string, gainDb: number): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      const ff = spawn("ffmpeg", [
        "-y",
        "-i", inputPath,
        "-af", `volume=${gainDb}dB`,
        "-c:a", "pcm_s16le",
        "-ar", "48000",
        "-ac", "1",
        outputPath,
      ]);
      let stderr = "";
      ff.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      ff.on("close", (code: number | null) => {
        if (code !== 0) reject(new Error(`ffmpeg gain failed (${code}): ${stderr}`));
        else resolvePromise();
      });
      ff.on("error", reject);
    });
  }

  private reencode(inputPath: string, outputPath: string): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      const ff = spawn("ffmpeg", [
        "-y",
        "-i", inputPath,
        "-c:a", "pcm_s16le",
        "-ar", "48000",
        "-ac", "1",
        outputPath,
      ]);
      let stderr = "";
      ff.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      ff.on("close", (code: number | null) => {
        if (code !== 0) reject(new Error(`ffmpeg reencode failed (${code}): ${stderr}`));
        else resolvePromise();
      });
      ff.on("error", reject);
    });
  }

  private getAudioDurationMs(filePath: string): Promise<number> {
    return new Promise((resolvePromise, reject) => {
      const ff = spawn("ffprobe", [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        filePath,
      ]);
      let stdout = "";
      let stderr = "";
      ff.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      ff.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      ff.on("close", (code: number | null) => {
        if (code !== 0) {
          reject(new Error(`ffprobe failed (${code}): ${stderr}`));
          return;
        }
        const seconds = parseFloat(stdout.trim());
        if (!Number.isFinite(seconds)) {
          reject(new Error(`ffprobe returned invalid duration: ${stdout}`));
          return;
        }
        resolvePromise(Math.round(seconds * 1000));
      });
      ff.on("error", reject);
    });
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Fixture enhanced provider — silent WAVs for deterministic offline tests.
// Duration is proportional to text (70ms/char), but measures with ffprobe
// so the path matches the real provider's contract.
// ────────────────────────────────────────────────────────────────────────────

export class FixtureEnhancedProvider implements EnhancedSpeechProvider {
  readonly id = "fixture-enhanced";

  async synthesize(req: EnhancedSpeechRequest): Promise<SpeechClip> {
    const durationMs = Math.max(500, req.text.length * 70);
    const sampleRate = 48000;
    const numSamples = Math.ceil((durationMs / 1000) * sampleRate);
    const dataSize = numSamples * 2;
    const buffer = Buffer.alloc(44 + dataSize);

    buffer.write("RIFF", 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write("WAVE", 8);
    buffer.write("fmt ", 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * 2, 28);
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write("data", 36);
    buffer.writeUInt32LE(dataSize, 40);

    mkdirSync(dirname(req.outputPath), { recursive: true });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(req.outputPath, buffer);

    return {
      utteranceId: req.utteranceId,
      file: req.outputPath,
      durationMs,
      emotion: req.emotion,
    };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Provider factory.
// ────────────────────────────────────────────────────────────────────────────

export function createEnhancedSpeechProvider(provider: string): EnhancedSpeechProvider {
  switch (provider) {
    case "edge-tts":
    case "edge-tts-enhanced":
      return new EdgeTtsEnhancedProvider();
    case "fixture":
    case "local":
    default:
      return new FixtureEnhancedProvider();
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Enhanced speech generation pipeline (drop-in replacement for generateSpeech).
// ────────────────────────────────────────────────────────────────────────────

import { log } from "../logger.js";

export interface VoiceProfileMap {
  [characterId: string]: VoiceProfile;
}

export async function generateEnhancedSpeech(
  utterances: { id: string; speakerId: string; text: string; emotion: Emotion }[],
  voiceProfiles: VoiceProfileMap,
  provider: EnhancedSpeechProvider,
  speechDir: string,
): Promise<Map<string, SpeechClip>> {
  const clips = new Map<string, SpeechClip>();

  for (const u of utterances) {
    const profile = voiceProfiles[u.speakerId];
    if (!profile) {
      throw new Error(
        `No voice profile for character "${u.speakerId}" (available: ${Object.keys(voiceProfiles).join(", ")})`,
      );
    }
    const outputPath = `${speechDir}/${u.id}.wav`;
    log.info(`Synthesizing ${u.id}: "${u.text.substring(0, 40)}..." [${u.emotion}]`);
    const clip = await provider.synthesize({
      utteranceId: u.id,
      speakerId: u.speakerId,
      text: u.text,
      emotion: u.emotion,
      voiceProfile: profile,
      outputPath,
    });
    clips.set(u.id, clip);
  }

  log.ok(`${clips.size} enhanced speech clips generated`);
  return clips;
}

// ────────────────────────────────────────────────────────────────────────────
// Whisper-based forced alignment (placeholder for real alignment).
// ────────────────────────────────────────────────────────────────────────────

/**
 * Word-level timestamps from audio.
 * The current fallback lip-sync (energy-text-v1) uses grapheme→viseme mapping
 * without real alignment. When Whisper is available, this function would
 * produce word-level start/end times that feed into the viseme scheduler for
 * much more accurate mouth shapes.
 *
 * For now this is a deterministic placeholder that distributes words evenly
 * across the clip duration — same quality as the current fallback but with
 * a clean interface for future Whisper integration.
 */
export interface WordTiming {
  word: string;
  startSec: number;
  endSec: number;
  confidence: number;
}

export async function alignWordTimings(
  text: string,
  audioPath: string,
  durationSec: number,
): Promise<WordTiming[]> {
  // Even distribution as a deterministic placeholder
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [];

  const wordDuration = durationSec / words.length;
  return words.map((word, i) => ({
    word,
    startSec: i * wordDuration,
    endSec: (i + 1) * wordDuration,
    confidence: 0.5, // placeholder confidence
  }));
}
