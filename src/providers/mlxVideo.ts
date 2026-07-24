/**
 * MLX Video provider adapter — local video generation on Apple Silicon.
 *
 * Spawns the `mlx-video` Python library (https://github.com/Blaizzy/mlx-video)
 * via `child_process.execFile` (no shell interpolation) and streams
 * stdout/stderr to the console in real time. Supports both the Wan 2.2
 * (`mlx_video.models.wan_2.generate`) and LTX-2
 * (`mlx_video.models.ltx_2.generate`) generation entry points.
 *
 * Environment variables:
 *
 *   MLX_VIDEO_PYTHON   Absolute path to a Python interpreter that has
 *                      `mlx-video` installed. When unset, the adapter falls
 *                      back to `.venv-mlx/bin/python` under the project root.
 *
 *   MLX_T2V_MODEL      Path to a Wan 2.2 text/image-to-video model directory.
 *                      Used by `resolveModelDir("wan22-ti2v-5b-q8")` when the
 *                      env var is set; otherwise `models/<modelName>` under
 *                      the project root is used.
 *
 *   MLX_AVATAR_MODEL   Path to a LongCat-Avatar (or other avatar) model
 *                      directory. Same fallback semantics as MLX_T2V_MODEL.
 *
 *   MLX_VIDEO_PROVIDER Selects which MLX backend to use ("wan" | "ltx").
 *                      Callers usually pick the function directly, but shared
 *                      dispatch code may read this to choose between
 *                      `generateVideo` (Wan) and `generateLTX`.
 *
 * All file operations are project-relative so the adapter works regardless of
 * the current working directory as long as the project layout is intact.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Options accepted by both {@link generateVideo} (Wan 2.2) and {@link generateLTX}
 * (LTX-2). Required fields are `modelDir`, `prompt`, and `outputPath`; everything
 * else has sensible defaults that match the upstream `mlx-video` CLI.
 */
export interface MLXVideoOptions {
  /** Path to the MLX model directory (e.g. `models/wan22-ti2v-5b-q8`). */
  modelDir: string;
  /** Text prompt describing the desired motion/scene. */
  prompt: string;
  /**
   * Path to a conditioning image for image-to-video (I2V) mode.
   * Omit for text-to-video (T2V) mode.
   */
  image?: string;
  /** Negative prompt — concepts to steer away from. */
  negativePrompt?: string;
  /** Output frame width in pixels. Default `1280`. */
  width?: number;
  /** Output frame height in pixels. Default `704`. */
  height?: number;
  /** Number of frames to generate. Default `81` (must be `4n + 1`). */
  numFrames?: number;
  /** Diffusion sampling steps. When omitted, the model config default is used. */
  steps?: number;
  /** Classifier-free guidance scale — a float or a `"low,high"` pair string. */
  guideScale?: string;
  /** PRNG seed. `-1` (default) lets the backend pick a random seed. */
  seed?: number;
  /** Output `.mp4` path. Parent directory should exist. */
  outputPath: string;
  /**
   * LTX-only pipeline variant. Ignored by the Wan 2.2 backend.
   * - `distilled`          — fastest, fewest steps
   * - `dev`                — standard dev pipeline
   * - `dev-two-stage`      — two-stage dev (quality/speed balance)
   * - `dev-two-stage-hq`   — two-stage dev, high quality
   */
  pipelineType?: "distilled" | "dev" | "dev-two-stage" | "dev-two-stage-hq";
  /**
   * Memory-tiling strategy passed through to `--tiling`. `auto` lets the
   * backend decide; the other values trade off speed vs. peak memory.
   */
  tiling?:
  | "auto"
  | "none"
  | "default"
  | "aggressive"
  | "conservative"
  | "spatial"
  | "temporal";
  /** Hard timeout in milliseconds. Default 30 minutes (`1_800_000`). */
  timeoutMs?: number;
}

/** Result returned by {@link generateVideo} and {@link generateLTX}. */
export interface MLXVideoResult {
  /** Absolute path of the generated `.mp4` (same value passed in `outputPath`). */
  outputPath: string;
  /** Full captured stdout produced by the Python subprocess. */
  stdout: string;
  /** Full captured stderr produced by the Python subprocess. */
  stderr: string;
  /** Wall-clock duration of the subprocess in milliseconds. */
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Default subprocess timeout — 30 minutes. MLX diffusion is slow on large frames. */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Project root, resolved from this module's location. `src/providers/mlxVideo.ts`
 * lives two directories below the root, so we walk up twice from `dirname(fileURL)`.
 */
const PROJECT_ROOT: string = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/**
 * Resolve the Python interpreter used to run `mlx-video`.
 *
 * Resolution order:
 *   1. `MLX_VIDEO_PYTHON` env var (must point to an existing file).
 *   2. `.venv-mlx/bin/python` relative to the project root.
 *
 * @throws If neither candidate exists on disk.
 */
export const getMLXPythonPath = (): string => {
  const envPath = process.env.MLX_VIDEO_PYTHON;
  if (envPath) {
    if (existsSync(envPath)) return envPath;
    throw new Error(
      `MLX_VIDEO_PYTHON is set to "${envPath}" but the file does not exist`,
    );
  }

  const fallback = resolve(PROJECT_ROOT, ".venv-mlx", "bin", "python");
  if (existsSync(fallback)) return fallback;

  throw new Error(
    `MLX Python interpreter not found. Set MLX_VIDEO_PYTHON or create ` +
      `.venv-mlx/ at the project root (${PROJECT_ROOT}).`,
  );
};

/**
 * Resolve a model directory path from an optional env override.
 *
 * Resolution order:
 *   1. `process.env[envVar]` — when the caller passes an env var name (e.g.
 *      `MLX_T2V_MODEL` or `MLX_AVATAR_MODEL`) and it is set, its value is used
 *      as-is (after `resolve`, so relative paths are anchored at the cwd).
 *   2. `models/<modelName>` relative to the project root.
 *
 * @param modelName  Directory name under `models/` (e.g. `wan22-ti2v-5b-q8`).
 * @param envVar     Optional env var name to consult before the fallback.
 */
export const resolveModelDir = (modelName: string, envVar?: string): string => {
  if (envVar) {
    const override = process.env[envVar];
    if (override) return resolve(override);
  }
  return resolve(PROJECT_ROOT, "models", modelName);
};

// ---------------------------------------------------------------------------
// Shared subprocess runner
// ---------------------------------------------------------------------------

/**
 * Build the shared CLI argument vector used by both the Wan 2.2 and LTX-2
 * `mlx_video` entry points. Order is stable so callers can reason about the
 * exact command line. Only flags relevant to a given backend are included.
 */
const buildArgs = (opts: MLXVideoOptions, ltx: boolean): string[] => {
  const args: string[] = [
    "-m",
    ltx ? "mlx_video.models.ltx_2.generate" : "mlx_video.models.wan_2.generate",
    "--model-dir",
    opts.modelDir,
    "--prompt",
    opts.prompt,
    "--output-path",
    opts.outputPath,
  ];

  // I2V conditioning image (omit for T2V).
  if (opts.image) {
    args.push("--image", opts.image);
  }

  // Optional negative prompt.
  if (opts.negativePrompt) {
    args.push("--negative-prompt", opts.negativePrompt);
  }

  // Frame geometry — mlx-video defaults to 1280x704, 81 frames.
  if (opts.width !== undefined) args.push("--width", String(opts.width));
  if (opts.height !== undefined) args.push("--height", String(opts.height));
  if (opts.numFrames !== undefined) args.push("--num-frames", String(opts.numFrames));

  // Sampling.
  if (opts.steps !== undefined) args.push("--steps", String(opts.steps));
  if (opts.guideScale !== undefined) args.push("--guide-scale", opts.guideScale);
  // seed defaults to -1 (random) when omitted.
  args.push("--seed", String(opts.seed ?? -1));

  // Tiling strategy.
  if (opts.tiling) {
    args.push("--tiling", opts.tiling);
  }

  // LTX-only pipeline variant.
  if (ltx && opts.pipelineType) {
    args.push("--pipeline-type", opts.pipelineType);
  }

  return args;
};

/**
 * Spawn the MLX video subprocess, stream stdout/stderr to the console in real
 * time, and resolve with a {@link MLXVideoResult}. Rejects on non-zero exit,
 * timeout, or spawn error.
 */
const runMLX = (
  opts: MLXVideoOptions,
  ltx: boolean,
): Promise<MLXVideoResult> => {
  const pythonPath = getMLXPythonPath();
  const args = buildArgs(opts, ltx);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();

  const backend = ltx ? "LTX-2" : "Wan 2.2";
  // eslint-disable-next-line no-console
  console.log(`[mlxVideo] ${backend} → ${pythonPath} ${args.join(" ")}`);

  return new Promise<MLXVideoResult>((resolveExec, rejectExec) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    // execFile bypasses the shell entirely — no interpolation of prompt text.
    const child = execFile(pythonPath, args, {
      maxBuffer: 1024 * 1024 * 512, // 512 MiB — MLX progress lines can be verbose.
      windowsHide: true,
      timeout: timeoutMs,
    });

    // Stream stdout in real time and accumulate for the result.
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      process.stdout.write(text);
    });
    // Stream stderr in real time and accumulate for the result.
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      process.stderr.write(text);
    });

    const cleanup = (): void => {
      if (child.stdout) child.stdout.removeAllListeners("data");
      if (child.stderr) child.stderr.removeAllListeners("data");
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      child.kill("SIGTERM");
      rejectExec(
        new Error(
          `[mlxVideo] ${backend} timed out after ${timeoutMs}ms\n${stderr}`,
        ),
      );
    }, timeoutMs);

    child.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      rejectExec(
        new Error(`[mlxVideo] ${backend} spawn error: ${err.message}\n${stderr}`),
      );
    });

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();

      const durationMs = Date.now() - startedAt;
      if (code === 0) {
        resolveExec({
          outputPath: resolve(opts.outputPath),
          stdout,
          stderr,
          durationMs,
        });
      } else if (signal) {
        rejectExec(
          new Error(
            `[mlxVideo] ${backend} killed by signal ${signal} after ${durationMs}ms\n${stderr}`,
          ),
        );
      } else {
        rejectExec(
          new Error(
            `[mlxVideo] ${backend} exited with code ${code} after ${durationMs}ms\n${stderr}`,
          ),
        );
      }
    });
  });
};

// ---------------------------------------------------------------------------
// Public generation entry points
// ---------------------------------------------------------------------------

/**
 * Generate a video clip with Wan 2.2 (`mlx_video.models.wan_2.generate`).
 *
 * Supports both text-to-video (T2V) — `prompt` only — and image-to-video
 * (I2V) — pass `image` pointing at a conditioning still. Throws if the
 * subprocess exits non-zero, times out (default 30 min, override with
 * `opts.timeoutMs`), or cannot be spawned.
 *
 * The MLX venv is expected at `.venv-mlx/bin/python` under the project root,
 * or at the path in `MLX_VIDEO_PYTHON`.
 */
export const generateVideo = async (
  opts: MLXVideoOptions,
): Promise<MLXVideoResult> => runMLX(opts, false);

/**
 * Generate a video clip with LTX-2 (`mlx_video.models.ltx_2.generate`).
 *
 * LTX exposes a `--pipeline-type` selector (`distilled`, `dev`,
 * `dev-two-stage`, `dev-two-stage-hq`) that trades off speed and quality.
 * Set it via `opts.pipelineType`; it is ignored by the Wan backend. Otherwise
 * the option surface is identical to {@link generateVideo}.
 */
export const generateLTX = async (
  opts: MLXVideoOptions,
): Promise<MLXVideoResult> => runMLX(opts, true);
