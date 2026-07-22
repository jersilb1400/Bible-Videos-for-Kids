import { ffprobe, probe } from "./providers/ffmpeg.js";
import { log } from "./logger.js";
import { config } from "./config.js";
import type { Production, Story } from "./types.js";

// ─── 1. Cost Estimation (pre-execution) ────────────────────────────

const PRICES = {
  grokImage: 0.50,   // Grok Imagine image gen
  grokVideo: 0.50,   // Grok Imagine video gen
  wanLocal: 0.00,     // self-hosted Wan (free)
  wanCloud: 0.05,     // cloud GPU per clip
  falImage: 0.04,     // fal Flux 2
  falVideo: 0.40,     // fal PixVerse V4.5
  elevenTTS: 0.04,    // ElevenLabs per scene
  kokoroTTS: 0.00,    // self-hosted Kokoro
  xaiTTS: 0.005,      // xAI TTS
  sunoMusic: 0.10,    // Suno per episode
  localMusic: 0.00,   // ffmpeg sine pad
  openRouterStory: 0.02, // story generation
  openRouterMeta: 0.01,  // metadata/seo
};

export function estimateCost(story: Story): { total: number; breakdown: string[] } {
  const n = story.scenes.length;
  const breakdown: string[] = [];

  // Story generation
  if (config.llm.apiKey) {
    breakdown.push(`  LLM story gen:      ~$${PRICES.openRouterStory.toFixed(2)}`);
  } else {
    breakdown.push("  LLM story gen:      $0.00 (built-in offline)");
  }

  // TTS
  if (config.tts.xaiKey) {
    const cost = n * PRICES.xaiTTS;
    breakdown.push(`  xAI TTS (${n} scenes): ~$${cost.toFixed(2)}`);
  } else if (config.tts.elevenKey) {
    const cost = n * PRICES.elevenTTS;
    breakdown.push(`  ElevenLabs TTS (${n} scenes): ~$${cost.toFixed(2)}`);
  } else if (config.tts.kokoroEndpoint) {
    breakdown.push("  Kokoro TTS:         $0.00 (self-hosted)");
  } else {
    breakdown.push("  TTS:                $0.00 (silent placeholder)");
  }

  // Images
  const premium = Math.ceil(n * 0.7);
  const filler = n - premium;
  if (config.image.falKey) {
    const cost = premium * PRICES.falImage;
    breakdown.push(`  Images (${premium} premium fal): ~$${cost.toFixed(2)}`);
  } else {
    breakdown.push(`  Images (${n} scenes):  $0.00 (local SVG)`);
  }

  // Animation
  let animCost = 0;
  if (config.xai.apiKey) {
    animCost = premium * PRICES.grokVideo;
    breakdown.push(`  Animation (${premium} Grok): ~$${animCost.toFixed(2)}`);
  } else if (config.video.wanEndpoint && !config.video.wanEndpoint.includes("localhost")) {
    animCost = premium * PRICES.wanCloud;
    breakdown.push(`  Animation (${premium} Wan cloud): ~$${animCost.toFixed(2)}`);
  } else if (config.video.wanEndpoint) {
    breakdown.push("  Animation:          $0.00 (local Wan)");
  } else {
    breakdown.push(`  Animation (${premium} premium): $0.00 (static test frames)`);
  }

  // Music
  if (config.music.sunoKey) {
    breakdown.push(`  Music (Suno):       ~$${PRICES.sunoMusic.toFixed(2)}`);
  } else {
    breakdown.push("  Music:              $0.00 (ffmpeg sine pad)");
  }

  // LLM metadata
  if (config.llm.apiKey) {
    breakdown.push(`  SEO metadata:       ~$${PRICES.openRouterMeta.toFixed(2)}`);
  } else {
    breakdown.push("  SEO metadata:       $0.00 (template)");
  }

  const total = animCost + (config.tts.xaiKey ? n * PRICES.xaiTTS : 0) +
    (config.image.falKey ? premium * PRICES.falImage : 0) +
    (config.llm.apiKey ? PRICES.openRouterStory + PRICES.openRouterMeta : 0) +
    (config.music.sunoKey ? PRICES.sunoMusic : 0);

  return { total, breakdown };
}

// ─── 2. Pre-Compose Validation Gate ────────────────────────────────

export interface ValidationResult {
  passed: boolean;
  errors: string[];
  warnings: string[];
}

export async function validateBeforeCompose(production: Production): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const n = production.story.scenes.length;

  // Clip count matches scenes
  if (production.sceneClips.length !== n) {
    errors.push(`Scene clips count (${production.sceneClips.length}) != scenes (${n})`);
  }

  // Each clip exists and is non-zero
  for (let i = 0; i < production.sceneClips.length; i++) {
    const clip = production.sceneClips[i];
    if (!clip) {
      errors.push(`Scene ${i + 1}: clip path is empty`);
      continue;
    }
    try {
      const info = await ffprobe(clip);
      const dur = parseFloat(info.duration || "0");
      if (dur <= 0.1) {
        errors.push(`Scene ${i + 1}: clip too short (${dur.toFixed(1)}s)`);
      }
      if (info.width && info.height) {
        const w = parseInt(info.width), h = parseInt(info.height);
        if (w < 320 || h < 240) {
          warnings.push(`Scene ${i + 1}: low resolution ${w}×${h}`);
        }
      }
    } catch {
      errors.push(`Scene ${i + 1}: clip not valid (${clip})`);
    }
  }

  // Narration files exist
  const narFiles = production.narrationAudio ? 
    (Array.isArray(production.narrationAudio) ? production.narrationAudio : [production.narrationAudio]) : [];
  for (const f of narFiles) {
    try {
      await ffprobe(f);
    } catch {
      errors.push(`Narration file not valid: ${f}`);
    }
  }

  // Duration consistency (warn only, assembly handles mismatches)
  for (let i = 0; i < production.sceneDurations.length && i < production.sceneClips.length; i++) {
    try {
      const clipInfo = await ffprobe(production.sceneClips[i]!);
      const clipDur = parseFloat(clipInfo.duration || "0");
      const targetDur = production.sceneDurations[i];
      if (Math.abs(clipDur - targetDur!) > 1) {
        warnings.push(`Scene ${i + 1}: clip duration ${clipDur.toFixed(1)}s vs target ${targetDur!.toFixed(1)}s`);
      }
    } catch { /* skip — already reported */ }
  }

  // Music file exists
  if (production.musicAudio) {
    try {
      await ffprobe(production.musicAudio);
    } catch {
      warnings.push(`Music file not valid: ${production.musicAudio}`);
    }
  }

  return {
    passed: errors.length === 0,
    errors,
    warnings,
  };
}

// ─── 3. Post-Render Self-Review ─────────────────────────────────────

export interface ReviewResult {
  passed: boolean;
  duration: number;
  resolution: string;
  hasAudio: boolean;
  errors: string[];
  warnings: string[];
}

export async function reviewOutput(videoPath: string): Promise<ReviewResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Probe video
  const info = await probe(videoPath);

  const duration = parseFloat(info.format?.duration || "0");
  const videoStream = info.streams?.find((s) => s.codec_type === "video");
  const audioStream = info.streams?.find((s) => s.codec_type === "audio");

  // Duration
  if (duration < 1) {
    errors.push(`Video too short: ${duration.toFixed(1)}s`);
  } else if (duration < 30) {
    warnings.push(`Short video: ${duration.toFixed(1)}s`);
  }

  // Resolution
  const vw = videoStream?.width ? parseInt(videoStream.width) : 0;
  const vh = videoStream?.height ? parseInt(videoStream.height) : 0;
  const resolution = videoStream 
    ? `${videoStream.width}×${videoStream.height}` 
    : "unknown";
  if (vw > 0 && vh > 0 && (vw < 640 || vh < 360)) {
    errors.push(`Resolution too low: ${resolution}`);
  }

  // Audio
  const hasAudio = !!audioStream;
  if (!hasAudio) {
    warnings.push("No audio track — this is normal in offline mode with silent TTS");
  }

  // Codec
  if (videoStream?.codec_name && !["h264", "hevc", "vp9"].includes(videoStream.codec_name)) {
    warnings.push(`Non-standard video codec: ${videoStream.codec_name}`);
  }

  return {
    passed: errors.length === 0,
    duration,
    resolution,
    hasAudio,
    errors,
    warnings,
  };
}