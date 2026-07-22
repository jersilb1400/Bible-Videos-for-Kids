import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type { Emotion } from "../types.js";

export interface SpeechRequest {
  utteranceId: string;
  speakerId: string;
  voiceId: string;
  text: string;
  emotion: Emotion;
  rate: number;
  pitch: number;
  outputPath: string; // .wav
}

export interface SpeechClip {
  utteranceId: string;
  file: string;
  durationMs: number; // from ffprobe, not estimates
}

export interface SpeechProvider {
  readonly id: string;
  synthesize(req: SpeechRequest): Promise<SpeechClip>;
}

/**
 * Fixture speech provider for deterministic tests.
 * Generates a silent WAV whose duration is proportional to the text length
 * so timeline compilation has realistic durations without network access.
 */
export class FixtureSpeechProvider implements SpeechProvider {
  readonly id = "fixture";

  async synthesize(req: SpeechRequest): Promise<SpeechClip> {
    // Estimate: ~70ms per character (roughly speaking pace for a child audience)
    const durationMs = Math.max(500, req.text.length * 70);

    // Generate a silent WAV file of the right duration
    const sampleRate = 48000;
    const numSamples = Math.ceil((durationMs / 1000) * sampleRate);
    const dataSize = numSamples * 2; // 16-bit mono
    const buffer = Buffer.alloc(44 + dataSize);

    // WAV header
    buffer.write("RIFF", 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write("WAVE", 8);
    buffer.write("fmt ", 12);
    buffer.writeUInt32LE(16, 16); // PCM chunk size
    buffer.writeUInt16LE(1, 20); // PCM format
    buffer.writeUInt16LE(1, 22); // mono
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
    buffer.writeUInt16LE(2, 32); // block align
    buffer.writeUInt16LE(16, 34); // bits per sample
    buffer.write("data", 36);
    buffer.writeUInt32LE(dataSize, 40);
    // PCM data is all zeros (silence) — fixture only

    // Ensure output directory exists
    mkdirSync(dirname(req.outputPath), { recursive: true });

    const { writeFileSync } = await import("node:fs");
    writeFileSync(req.outputPath, buffer);

    return {
      utteranceId: req.utteranceId,
      file: req.outputPath,
      durationMs,
    };
  }
}

/**
 * Get audio duration in milliseconds using ffprobe.
 */
export async function getAudioDurationMs(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath,
    ]);
    let stdout = "";
    let stderr = "";
    ff.stdout.on("data", (d) => (stdout += d));
    ff.stderr.on("data", (d) => (stderr += d));
    ff.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe failed (${code}): ${stderr}`));
        return;
      }
      const seconds = parseFloat(stdout.trim());
      if (!Number.isFinite(seconds)) {
        reject(new Error(`ffprobe returned invalid duration: ${stdout}`));
        return;
      }
      resolve(Math.round(seconds * 1000));
    });
    ff.on("error", reject);
  });
}

/**
 * Edge-TTS speech provider (free, uses Microsoft Edge TTS).
 * Falls back to fixture if edge-tts is not installed.
 */
export class EdgeTtsSpeechProvider implements SpeechProvider {
  readonly id = "edge-tts";

  async synthesize(req: SpeechRequest): Promise<SpeechClip> {
    // Check if edge-tts is available
    const edgeTtsPath = resolve("node_modules/.bin/edge-tts");
    if (!existsSync(edgeTtsPath)) {
      // Fall back to fixture
      const fixture = new FixtureSpeechProvider();
      return fixture.synthesize(req);
    }

    mkdirSync(dirname(req.outputPath), { recursive: true });

    const ratePercent = `${req.rate > 1 ? "+" : ""}${Math.round((req.rate - 1) * 100)}%`;
    const pitchHz = `${req.pitch > 0 ? "+" : ""}${req.pitch}Hz`;

    return new Promise((resolve, reject) => {
      const args = [
        "--voice", req.voiceId,
        "--rate", ratePercent,
        "--pitch", pitchHz,
        "--text", req.text,
        "--write-media", req.outputPath,
      ];

      const tts = spawn(edgeTtsPath, args);
      let stderr = "";
      tts.stderr.on("data", (d) => (stderr += d));
      tts.on("close", async (code) => {
        if (code !== 0) {
          reject(new Error(`edge-tts failed (${code}): ${stderr}`));
          return;
        }
        try {
          const durationMs = await getAudioDurationMs(req.outputPath);
          resolve({
            utteranceId: req.utteranceId,
            file: req.outputPath,
            durationMs,
          });
        } catch (err) {
          reject(err);
        }
      });
      tts.on("error", reject);
    });
  }
}

/**
 * Resolve which speech provider to use based on config.
 */
export function createSpeechProvider(provider: string): SpeechProvider {
  switch (provider) {
    case "edge-tts":
      return new EdgeTtsSpeechProvider();
    case "fixture":
    case "local":
    default:
      return new FixtureSpeechProvider();
  }
}
