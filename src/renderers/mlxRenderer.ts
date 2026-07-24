import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { HeadlessRenderer, RenderShotRequest, RenderedShot } from "./types.js";
import type { Shot } from "../types.js";
import type { ShotTimeline } from "../timeline.js";
import { generateVideo, generateLTX, resolveModelDir } from "../providers/mlxVideo.js";
import { svgCutoutRenderer } from "./svgCutout.js";

// ────────────────────────────────────────────────────────────────────────────
// MLX renderer — uses local mlx-video (Wan 2.2 / LTX-2) to generate video
// clips from a text prompt, optionally conditioned on a first-frame still.
//
// This renderer is **experimental**: it delegates to the MLX subprocess for
// the actual generation and falls back to the SVG cut-out renderer on any
// error. Cross-shot character identity is NOT guaranteed; use behind
// RENDERER=mlx and review the output.
// ────────────────────────────────────────────────────────────────────────────

/** Which MLX backend to use. Defaults to Wan 2.2. */
const MLX_BACKEND: "wan" | "ltx" =
  (process.env.MLX_BACKEND as "wan" | "ltx" | undefined) ?? "wan";

/** Default model directory names under `models/` (or overridden via env). */
const WAN_MODEL_NAME = process.env.MLX_MODEL || "wan22-ti2v-5b-q8";
const LTX_MODEL_NAME = process.env.MLX_LTX_MODEL || "ltx-2.3-mlx-q4";

/** Default generation quality presets. */
const DEFAULT_STEPS = 30;
const DEFAULT_TILING = "auto" as const;
/** Hard timeout — MLX diffusion can be very slow on large frames. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes per shot

// ────────────────────────────────────────────────────────────────────────────
// Prompt construction
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build a visual generation prompt from a shot's setting, actors, and
 * dialogue. The prompt is a compact text description that tells the MLX
 * model what kind of scene to generate — it is NOT a script or dialogue
 * cue. The renderer does not feed dialogue to the MLX model; speech is
 * muxed during assembly.
 */
function buildShotPrompt(shot: Shot, timeline: ShotTimeline): string {
  const parts: string[] = [];

  // Setting / environment
  const setting = shot.settingId.replace(/^(setting:|bg:)/, "");
  parts.push(`a gentle children's cartoon scene in ${setting}`);

  // Characters on stage
  const actorNames = shot.actors
    .map((a) => a.characterId)
    .filter(Boolean);
  if (actorNames.length > 0) {
    parts.push(`with ${actorNames.join(" and ")}`);
  }

  // Camera motion hint
  if (shot.camera === "push-in") {
    parts.push("slow camera push-in");
  } else if (shot.camera === "pan-left") {
    parts.push("slow camera pan left");
  } else if (shot.camera === "pan-right") {
    parts.push("slow camera pan right");
  }

  // Action context (if non-legacy)
  if (shot.action && !/legacy/i.test(shot.action)) {
    parts.push(shot.action);
  }

  // Style guidance
  parts.push("cute 2D animated cartoon style for children ages 3-8");
  parts.push("bright warm colors, friendly, joyful, safe for kids");

  return parts.join(", ");
}

/**
 * Compute the number of frames for the MLX backend.
 *
 * Wan 2.2 requires `4n + 1` frames; LTX-2 requires `8n + 1`.
 * We round up to the nearest valid frame count that covers the shot's
 * duration, capped at a reasonable maximum (193 frames ≈ 8s at 24fps).
 */
function computeNumFrames(timeline: ShotTimeline, fps: number): number {
  const durationSec = timeline.durationMs / 1000;
  const minFrames = Math.ceil(durationSec * fps);

  const stride = MLX_BACKEND === "ltx" ? 8 : 4;
  const maxFrames = 193;

  // Find the smallest k where stride*k + 1 >= minFrames and <= maxFrames.
  const k = Math.ceil((minFrames - 1) / stride);
  let frames = stride * k + 1;

  if (frames < stride + 1) {
    frames = stride + 1; // minimum 2 strides + 1
  }
  if (frames > maxFrames) {
    frames = maxFrames;
    // Round down to nearest valid count
    const maxK = Math.floor((maxFrames - 1) / stride);
    frames = stride * maxK + 1;
  }

  return frames;
}

// ────────────────────────────────────────────────────────────────────────────
// Duration probing via ffprobe (re-implementation for renderer-local use)
// ────────────────────────────────────────────────────────────────────────────

function probeDurationMs(filePath: string): Promise<number> {
  return new Promise((pResolve, pReject) => {
    const child = execFile(
      "ffprobe",
      [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        filePath,
      ],
      { timeout: 10_000 },
    );
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on("data", () => { /* swallow */ });
    child.on("close", (code: number | null) => {
      if (code !== 0) {
        pReject(new Error(`ffprobe exited ${code} probing ${filePath}`));
        return;
      }
      const seconds = parseFloat(stdout.trim());
      if (!Number.isFinite(seconds)) {
        pReject(new Error(`ffprobe returned invalid duration: ${stdout}`));
        return;
      }
      pResolve(Math.round(seconds * 1000));
    });
    child.on("error", pReject);
  });
}

// ────────────────────────────────────────────────────────────────────────────
// MLX renderer class
// ────────────────────────────────────────────────────────────────────────────

export class MlxRenderer implements HeadlessRenderer {
  readonly id = MLX_BACKEND === "ltx" ? "mlx-ltx2" : "mlx-wan22";

  async renderShot(req: RenderShotRequest): Promise<RenderedShot> {
    const { shot, timeline, width, height, fps, seed, outputFile } = req;

    // Ensure output directory exists
    mkdirSync(dirname(outputFile), { recursive: true });

    // Build the generation prompt
    const prompt = buildShotPrompt(shot, timeline);

    // Compute frame count
    const numFrames = computeNumFrames(timeline, fps);

    // Resolve model directory
    const modelName = MLX_BACKEND === "ltx" ? LTX_MODEL_NAME : WAN_MODEL_NAME;
    const envVar = MLX_BACKEND === "ltx" ? "MLX_LTX_MODEL" : "MLX_MODEL";
    const modelDir = resolveModelDir(modelName, envVar);

    // Optional conditioning image (image-to-video mode).
    // If a still image exists at the shot's expected path, use it as the
    // first-frame conditioning input. The images stage writes scene stills
    // to sceneImages[] in Production, but the v2 pipeline does not pass them
    // through RenderShotRequest. For now, we check for a convention path.
    const conditioningImage = this.findConditioningImage(shot.id, dirname(outputFile));

    const opts = {
      modelDir,
      prompt,
      ...(conditioningImage ? { image: conditioningImage } : {}),
      width,
      height,
      numFrames,
      steps: process.env.MLX_STEPS ? parseInt(process.env.MLX_STEPS, 10) : DEFAULT_STEPS,
      tiling: DEFAULT_TILING,
      seed,
      outputPath: outputFile,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    };

    try {
      // eslint-disable-next-line no-console
      console.log(
        `[mlxRenderer] ${this.id} shot=${shot.id} frames=${numFrames} ` +
        `model=${modelName} image=${conditioningImage ? "yes" : "no"}`,
      );

      const result = MLX_BACKEND === "ltx"
        ? await generateLTX(opts)
        : await generateVideo(opts);

      // Probe the actual duration of the generated clip.
      // If MLX produced a shorter clip (e.g. capped at 193 frames ≈ 8s),
      // still return the timeline's durationMs so assembly's audio/video
      // sync is preserved. The concat demuxer pads with repeat frames.
      let durationMs = timeline.durationMs;
      try {
        const actualMs = await probeDurationMs(result.outputPath);
        // Use the probed duration only if it's close to the expected one
        // (within 500ms tolerance). If significantly shorter, the assembly
        // stage will handle the mismatch (concat copy may produce a shorter
        // final video, but audio is built from real speech clips which are
        // always correct).
        if (Math.abs(actualMs - timeline.durationMs) < 500) {
          durationMs = actualMs;
        }
      } catch {
        // If ffprobe fails, fall back to the timeline duration
        // eslint-disable-next-line no-console
        console.warn(`[mlxRenderer] ffprobe failed on ${result.outputPath}; using timeline duration`);
      }

      const frameCount = numFrames;

      return {
        shotId: shot.id,
        file: result.outputPath,
        durationMs,
        frameCount,
        renderer: this.id,
      };
    } catch (err) {
      // Fall back to SVG cutout renderer
      // eslint-disable-next-line no-console
      console.warn(
        `[mlxRenderer] MLX generation failed for shot ${shot.id}: ` +
        `${(err as Error).message}. Falling back to SVG cutout renderer.`,
      );

      // Delegate to the SVG renderer — it handles its own frame rendering
      // and ffmpeg encoding.
      return svgCutoutRenderer.renderShot(req);
    }
  }

  /**
   * Look for a conditioning still image for this shot.
   *
   * Convention: the images stage writes per-scene stills, but the v2 pipeline
   * doesn't pass them through RenderShotRequest. We check a few common
   * locations relative to the output directory.
   */
  private findConditioningImage(shotId: string, outputDir: string): string | undefined {
    const candidates = [
      resolve(outputDir, `stills/${shotId}.png`),
      resolve(outputDir, `stills/${shotId}.jpg`),
      resolve(outputDir, `images/${shotId}.png`),
      resolve(outputDir, `${shotId}.png`),
    ];
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
    return undefined;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Public module surface
// ────────────────────────────────────────────────────────────────────────────

/**
 * Factory that creates a fresh MLX renderer instance. Env vars
 * (`MLX_BACKEND`, `MLX_MODEL`, `MLX_STEPS`) are read at call time so
 * pipelineV2 can construct the renderer after config is loaded.
 */
export function createMlxRenderer(): MlxRenderer {
  return new MlxRenderer();
}
