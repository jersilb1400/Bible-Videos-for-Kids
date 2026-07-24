/**
 * MLX Music provider — generates music beds using ACE-Step 1.5 XL Turbo
 * via the MLX Core server (http://127.0.0.1:11234/v1/audio/music-generations).
 *
 * The MLX Core server runs ACE-Step locally on Apple Silicon, producing
 * instrumental music beds from a text prompt. No external API calls.
 *
 * Environment variables:
 *
 *   MLX_CORE_URL       Base URL for MLX Core server. Default http://127.0.0.1:11234
 *   MLX_MUSIC_MODEL     Model name (default: auto-selected by server)
 *   MLX_MUSIC_STEPS     Diffusion steps (default: 50)
 *   MLX_MUSIC_GUIDANCE  Guidance scale (default: 3.0)
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export type MusicMood =
  | "warm"
  | "joyful"
  | "wonder"
  | "gentle-tension"
  | "celebration"
  | "prayer";

export interface MLXMusicOptions {
  /** Emotional mood/category for the music. */
  mood: MusicMood;
  /** Duration in seconds (10-600). Default 30. */
  durationSec?: number;
  /** Output path (.wav or .m4a). Parent dir is created if needed. */
  outputPath: string;
  /** PRNG seed for reproducibility. -1 = random. */
  seed?: number;
  /** Diffusion steps. Default 50. */
  steps?: number;
  /** Guidance scale. Default 3.0. */
  guidanceScale?: number;
  /** Tempo in BPM. Default 100. */
  bpm?: number;
  /** Musical key. Default "C". */
  keyScale?: string;
}

export interface MLXMusicResult {
  outputPath: string;
  durationSec: number;
  mood: MusicMood;
}

// ────────────────────────────────────────────────────────────────────────────
// Mood → prompt mapping
// ────────────────────────────────────────────────────────────────────────────

const MOOD_PROMPTS: Record<MusicMood, string> = {
  warm: "warm gentle acoustic guitar and soft piano, relaxing children's background music, peaceful and comforting",
  joyful: "upbeat cheerful ukulele and xylophone, playful happy children's music, bright and energetic",
  wonder: "magical sparkling chimes and soft strings, wonder and discovery, gentle orchestral swell",
  "gentle-tension": "soft dramatic strings with light percussion, gentle tension suitable for children's storytelling, not scary",
  celebration: "festive brass and hand claps, joyful celebration music, triumphant and happy",
  prayer: "soft ambient pad with gentle piano, prayerful and reflective, peaceful ending",
};

// ────────────────────────────────────────────────────────────────────────────
// MLX Core API call
// ────────────────────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = "http://127.0.0.1:11234";

/**
 * Check if the MLX Core server is reachable and has the music model loaded.
 */
export async function isMLXMusicAvailable(): Promise<boolean> {
  const baseUrl = process.env.MLX_CORE_URL ?? DEFAULT_BASE_URL;
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return false;

    // Check if any music model is available
    const modelsRes = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(3000) });
    if (!modelsRes.ok) return false;

    const data = await modelsRes.json() as { data?: Array<{ id: string }> };
    const models = data.data ?? [];

    // Check for ACE-Step or any music model
    const hasMusicModel = models.some(
      (m) => m.id.toLowerCase().includes("ace-step") ||
             m.id.toLowerCase().includes("music"),
    );

    return hasMusicModel;
  } catch {
    return false;
  }
}

/**
 * Generate music using MLX Core's ACE-Step 1.5 XL Turbo.
 *
 * @throws If the server is unreachable or generation fails.
 */
export async function generateMLXMusic(opts: MLXMusicOptions): Promise<MLXMusicResult> {
  const baseUrl = process.env.MLX_CORE_URL ?? DEFAULT_BASE_URL;
  const durationSec = opts.durationSec ?? 30;
  const steps = opts.steps ?? parseInt(process.env.MLX_MUSIC_STEPS ?? "50", 10);
  const guidance = opts.guidanceScale ?? parseFloat(process.env.MLX_MUSIC_GUIDANCE ?? "3.0");
  const seed = opts.seed ?? -1;
  const bpm = opts.bpm ?? 100;
  const keyScale = opts.keyScale ?? "C";

  // Ensure output directory exists
  mkdirSync(dirname(opts.outputPath), { recursive: true });

  const prompt = MOOD_PROMPTS[opts.mood];

  // eslint-disable-next-line no-console
  console.log(
    `[mlxMusic] mood=${opts.mood} duration=${durationSec}s ` +
    `steps=${steps} guidance=${guidance} → ${opts.outputPath}`,
  );

  const body = {
    prompt,
    duration: durationSec,
    instrumental: true,
    format: "wav",
    seed,
    steps,
    guidance_scale: guidance,
    bpm,
    keyscale: keyScale,
  };

  const res = await fetch(`${baseUrl}/v1/audio/music-generations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10 * 60 * 1000), // 10 min max
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "unknown error");
    throw new Error(`MLX music generation failed (${res.status}): ${text}`);
  }

  // The server returns binary audio data (WAV)
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.startsWith("audio/") || contentType.startsWith("application/octet-stream")) {
    const buffer = Buffer.from(await res.arrayBuffer());
    writeFileSync(opts.outputPath, buffer);
    return { outputPath: resolve(opts.outputPath), durationSec, mood: opts.mood };
  }

  // Some servers return a JSON body with a URL
  const data = await res.json() as { url?: string; audio_base64?: string };
  if (data.url) {
    const audioRes = await fetch(data.url, { signal: AbortSignal.timeout(60_000) });
    const buffer = Buffer.from(await audioRes.arrayBuffer());
    writeFileSync(opts.outputPath, buffer);
    return { outputPath: resolve(opts.outputPath), durationSec, mood: opts.mood };
  }

  if (data.audio_base64) {
    const buffer = Buffer.from(data.audio_base64, "base64");
    writeFileSync(opts.outputPath, buffer);
    return { outputPath: resolve(opts.outputPath), durationSec, mood: opts.mood };
  }

  throw new Error("MLX music generation: unexpected response format (no audio data)");
}
