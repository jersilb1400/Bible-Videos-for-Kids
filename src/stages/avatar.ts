/**
 * Avatar pipeline — generates lip-synced talking-character video clips
 * using LongCat-Avatar 1.5 on MLX.
 *
 * For each dialogue utterance:
 *   1. Use the already-generated speech clip (TTS WAV)
 *   2. Find the character's reference portrait image
 *   3. Call LongCat-Avatar to generate a lip-synced video clip
 *   4. Return per-utterance video clips for assembly
 *
 * Falls back gracefully when the avatar model is not installed — returns
 * null signals so the caller can use the SVG renderer's mouth animation.
 *
 * Environment variables:
 *   MLX_AVATAR_MODEL    Path to LongCat-Avatar weights
 *   AVATAR_ENABLE       Set to "true" to enable avatar generation
 *   AVATAR_WIDTH        Output width (default 480, tune for memory)
 *   AVATAR_HEIGHT       Output height (default 480)
 *   AVATAR_STEPS        Diffusion steps (default 25, more = better quality)
 */

import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { log } from "../logger.js";
import { generateAvatarVideo, isAvatarAvailable } from "../providers/mlxAvatar.js";
import type { Episode, Shot } from "../types.js";
import type { SpeechClip } from "../providers/speech.js";
import type { ShotTimeline, PlacedUtterance } from "../timeline.js";
import type { ResolvedRig } from "../assets.js";
import type { ResolvedAsset } from "../assets.js";

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export interface AvatarClip {
  utteranceId: string;
  shotId: string;
  speakerId: string;
  /** Path to the generated video clip (.mp4) */
  file: string;
  /** Duration in milliseconds (from ffprobe) */
  durationMs: number;
  /** Which renderer produced this clip */
  renderer: string;
}

export interface AvatarPipelineOptions {
  /** Episode being rendered */
  episode: Episode;
  /** Per-utterance speech clips (from speech stage) */
  clips: Map<string, SpeechClip>;
  /** Resolved rig map (characterId → rig with body paths) */
  rigs: Map<string, ResolvedRig>;
  /** Episode timeline */
  timeline: {
    shots: ShotTimeline[];
  };
  /** Output directory for avatar clips */
  outputDir: string;
  /** Whether to enable avatar generation (default: false) */
  enabled?: boolean;
}

export interface AvatarPipelineResult {
  /** utteranceId → AvatarClip map */
  clips: Map<string, AvatarClip>;
  /** Whether the avatar model was available */
  available: boolean;
  /** Error message if avatar generation was attempted but failed */
  error?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Reference image resolution
// ────────────────────────────────────────────────────────────────────────────

/**
 * Find a reference portrait image for a character.
 *
 * Resolution order:
 *   1. assets/portraits/<characterId>.png (canonical portrait)
 *   2. The rig's body SVG rasterized to PNG (would need conversion)
 *   3. None (caller must provide a fallback)
 *
 * In the current pipeline, character rigs are SVG-based. LongCat-Avatar
 * needs a raster reference image. A separate portraits directory or
 * pre-rasterized body image is required.
 */
function findReferenceImage(
  speakerId: string,
  rigs: Map<string, ResolvedRig>,
): string | undefined {
  // Check for pre-rendered portrait images
  const portraitPaths = [
    `assets/portraits/${speakerId}.png`,
    `assets/portraits/${speakerId}.jpg`,
  ];

  for (const p of portraitPaths) {
    const abs = resolve(process.cwd(), p);
    if (existsSync(abs)) return abs;
  }

  // Check if the rig has a body PNG (some rigs may have rasterized versions)
  const rig = rigs.get(speakerId);
  if (rig) {
    const bodyPng = rig.body.pathname.replace(/\.svg$/, ".png");
    if (existsSync(bodyPng)) return bodyPng;
  }

  return undefined;
}

// ────────────────────────────────────────────────────────────────────────────
// Avatar pipeline
// ────────────────────────────────────────────────────────────────────────────

/**
 * Generate lip-synced avatar video clips for all dialogue utterances.
 *
 * This is an optional enhancement stage — when the LongCat-Avatar model
 * is not available or AVATAR_ENABLE is not set, returns an empty result
 * and the pipeline falls back to the SVG renderer's viseme-based mouth
 * animation.
 */
export async function generateAvatarClips(
  opts: AvatarPipelineOptions,
): Promise<AvatarPipelineResult> {
  const enabled = opts.enabled ?? (process.env.AVATAR_ENABLE === "true");
  const clips = new Map<string, AvatarClip>();

  if (!enabled) {
    log.info("Avatar pipeline disabled (set AVATAR_ENABLE=true to enable)");
    return { clips, available: false };
  }

  // Check if LongCat-Avatar is available before attempting any generation
  if (!isAvatarAvailable()) {
    log.warn(
      "LongCat-Avatar not available. Install the model and Python package " +
        "to enable audio-driven lip sync. Falling back to SVG viseme animation.",
    );
    return { clips, available: false };
  }

  log.stage("Avatar  (LongCat-Avatar lip-sync generation)");
  log.info("LongCat-Avatar available — generating lip-synced clips");

  const width = parseInt(process.env.AVATAR_WIDTH ?? "480", 10);
  const height = parseInt(process.env.AVATAR_HEIGHT ?? "480", 10);
  const steps = parseInt(process.env.AVATAR_STEPS ?? "25", 10);

  let generated = 0;
  let skipped = 0;

  for (const shot of opts.episode.shots) {
    for (const line of shot.dialogue) {
      const speechClip = opts.clips.get(line.id);
      if (!speechClip) {
        log.info(`Avatar: no speech clip for ${line.id}, skipping`);
        skipped++;
        continue;
      }

      const refImage = findReferenceImage(line.speakerId, opts.rigs);
      if (!refImage) {
        log.info(
          `Avatar: no reference image for ${line.speakerId}, skipping ${line.id}`,
        );
        skipped++;
        continue;
      }

      const outputFile = join(opts.outputDir, `avatar/${line.id}.mp4`);

      try {
        log.info(`Avatar: generating clip for ${line.id} (speaker: ${line.speakerId})`);
        const result = await generateAvatarVideo({
          referenceImage: refImage,
          audioPath: speechClip.file,
          outputPath: outputFile,
          prompt: `${line.speakerId} speaking with ${line.emotion} emotion`,
          width,
          height,
          steps,
          seed: -1, // random for each clip
        });

        clips.set(line.id, {
          utteranceId: line.id,
          shotId: shot.id,
          speakerId: line.speakerId,
          file: result.outputPath,
          durationMs: speechClip.durationMs,
          renderer: "longcat-avatar-1.5",
        });
        generated++;
      } catch (err) {
        log.warn(`Avatar generation failed for ${line.id}: ${(err as Error).message}`);
        skipped++;
      }
    }
  }

  log.ok(`Avatar clips: ${generated} generated, ${skipped} skipped`);

  return {
    clips,
    available: true,
    ...(skipped > 0 && generated === 0
      ? { error: "All avatar clips failed — falling back to SVG renderer" }
      : {}),
  };
}

/**
 * Check if avatar clips exist for a given utterance.
 * Used by the renderer to decide whether to use avatar video or SVG animation.
 */
export function hasAvatarClip(
  avatarClips: Map<string, AvatarClip>,
  utteranceId: string,
): boolean {
  return avatarClips.has(utteranceId);
}
