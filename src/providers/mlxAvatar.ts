/**
 * MLX Avatar provider — audio-driven lip-synced video generation using
 * LongCat-Video-Avatar 1.5 (MLX port) on Apple Silicon.
 *
 * LongCat-Avatar takes a reference portrait image + an audio clip and
 * generates a video where the character's lips, facial expression, and
 * head pose are driven by the audio signal. This is the "talking head"
 * approach that produces realistic lip-sync without manual viseme rigging.
 *
 * The MLX port lives at:
 *   https://huggingface.co/mlx-community/LongCat-Video-Avatar-1.5-bf16-dmd-merged
 *   Source: https://github.com/xocialize/longcat-avatar-mlx
 *
 * Requires:
 *   - The `longcat-video-avatar` Python package installed in the MLX venv
 *   - The model weights downloaded (see MLX_AVATAR_MODEL env var)
 *   - 64 GB+ unified memory recommended for 480p (will work on 48 GB at lower res)
 *
 * Environment variables:
 *
 *   MLX_AVATAR_MODEL   Path to the LongCat-Avatar model weights directory.
 *                      Falls back to `models/longcat-avatar-1.5` under
 *                      the project root.
 *
 *   MLX_VIDEO_PYTHON   Python interpreter with the avatar package installed.
 *                      Falls back to `.venv-mlx/bin/python`.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export interface AvatarOptions {
  /** Path to a reference portrait image (PNG/JPG) of the character. */
  referenceImage: string;
  /** Path to the audio file (WAV/MP3) that drives the lip sync. */
  audioPath: string;
  /** Output video path (.mp4). Parent directory should exist. */
  outputPath: string;
  /** Optional text prompt describing the character/scene (for conditioning). */
  prompt?: string;
  /** Negative prompt — things to avoid. */
  negativePrompt?: string;
  /** Output width in pixels. Default 480 (tuned for 48 GB Macs). */
  width?: number;
  /** Output height in pixels. Default 480. */
  height?: number;
  /** Number of frames. If omitted, computed from audio duration. */
  numFrames?: number;
  /** Diffusion steps. Default 25. */
  steps?: number;
  /** Guidance scale. Default 5.0. */
  guidanceScale?: number;
  /** PRNG seed. -1 = random. */
  seed?: number;
  /** Hard timeout in ms. Default 15 minutes. */
  timeoutMs?: number;
}

export interface AvatarResult {
  /** Absolute path to the generated .mp4 */
  outputPath: string;
  /** Full captured stdout */
  stdout: string;
  /** Full captured stderr */
  stderr: string;
  /** Wall-clock duration in ms */
  durationMs: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Path helpers (mirrors mlxVideo.ts conventions)
// ────────────────────────────────────────────────────────────────────────────

const PROJECT_ROOT: string = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes — avatar diffusion is slow

/**
 * Resolve the Python interpreter for LongCat-Avatar.
 * Same resolution order as mlxVideo.ts:
 *   1. MLX_VIDEO_PYTHON env var
 *   2. .venv-mlx/bin/python under project root
 */
function getPythonPath(): string {
  const envPath = process.env.MLX_VIDEO_PYTHON;
  if (envPath && existsSync(envPath)) return envPath;

  const fallback = resolve(PROJECT_ROOT, ".venv-mlx", "bin", "python");
  if (existsSync(fallback)) return fallback;

  throw new Error(
    "MLX Python interpreter not found. Set MLX_VIDEO_PYTHON or create " +
      `.venv-mlx/ at the project root (${PROJECT_ROOT}).`,
  );
}

/**
 * Resolve the LongCat-Avatar model directory.
 *   1. MLX_AVATAR_MODEL env var
 *   2. models/longcat-avatar-1.5 under project root
 */
function getModelDir(): string {
  const envModel = process.env.MLX_AVATAR_MODEL;
  if (envModel) return resolve(envModel);
  return resolve(PROJECT_ROOT, "models", "longcat-avatar-1.5");
}

// ────────────────────────────────────────────────────────────────────────────
// Python inference script (inline — no separate .py file needed)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build a Python script that loads LongCat-Avatar and generates a video.
 * The script is self-contained and communicates results via exit codes.
 *
 * The script uses the longcat_video_avatar Python API directly (not a CLI
 * wrapper) so we have full control over the pipeline.
 */
function buildInferenceScript(opts: AvatarOptions, modelDir: string): string {
  const width = opts.width ?? 480;
  const height = opts.height ?? 480;
  const steps = opts.steps ?? 25;
  const guidance = opts.guidanceScale ?? 5.0;
  const seed = opts.seed ?? -1;

  return `
import json
import pathlib
import sys

# Ensure the model directory exists
model_dir = pathlib.Path("${modelDir}")
if not model_dir.exists():
    print(f"ERROR: Avatar model directory not found: {model_dir}", file=sys.stderr)
    sys.exit(1)

try:
    import mlx.core as mx
    from longcat_video_avatar.pipeline_mlx import LongCatAvatarPipeline, PipelineConfig
    from longcat_video_avatar.models.autoencoder_kl_wan import AutoencoderKLWan
    from longcat_video_avatar.models.avatar.longcat_video_dit_avatar import (
        LongCatVideoAvatarTransformer3DModel,
    )
    from longcat_video_avatar.models.umt5 import UMT5EncoderModel
    from longcat_video_avatar.models.whisper import WhisperEncoder
except ImportError as e:
    print(f"ERROR: longcat_video_avatar not installed: {e}", file=sys.stderr)
    print("Install with: pip install longcat-video-avatar", file=sys.stderr)
    sys.exit(2)

W = model_dir

# Load model components
try:
    vae = AutoencoderKLWan.from_config(json.loads((W / "vae/config.json").read_text()))
    vae.load_weights(str(W / "vae/diffusion_pytorch_model.safetensors"), strict=False)

    text_encoder = UMT5EncoderModel.from_pretrained(str(W / "umt5"))
    audio_encoder = WhisperEncoder.from_pretrained(str(W / "whisper"))
    dit = LongCatVideoAvatarTransformer3DModel.from_pretrained(str(W / "dit"))
except Exception as e:
    print(f"ERROR: Failed to load model components: {e}", file=sys.stderr)
    sys.exit(3)

# Build pipeline
config = PipelineConfig(
    width=${width},
    height=${height},
    num_steps=${steps},
    guidance_scale=${guidance},
    seed=${seed},
)

pipeline = LongCatAvatarPipeline(
    vae=vae,
    text_encoder=text_encoder,
    audio_encoder=audio_encoder,
    dit=dit,
    config=config,
)

# Load reference image
from PIL import Image
import numpy as np
ref_image = Image.open("${opts.referenceImage}").convert("RGB")
ref_image = ref_image.resize(($width, $height))
ref_chw = mx.array(np.array(ref_image).transpose(2, 0, 1)) / 255.0

# Load audio and extract mel features
import librosa
audio, sr = librosa.load("${opts.audioPath}", sr=16000)
mel_features = pipeline.extract_mel(audio)

# Optional text conditioning
text_embeds = None
text_mask = None
uncond_embeds = None
uncond_mask = None
prompt = ${JSON.stringify(opts.prompt ?? "")}
if prompt:
    text_embeds, text_mask = pipeline.encode_text(prompt)
    uncond_embeds, uncond_mask = pipeline.encode_text("")

# Generate
video = pipeline(
    image=ref_chw,
    audio_mel=mel_features,
    text_embeds=text_embeds,
    text_mask=text_mask,
    uncond_embeds=uncond_embeds,
    uncond_mask=uncond_mask,
)

# Save output
pipeline.save_video(video, "${opts.outputPath}")
print(f"OK: Avatar video saved to ${opts.outputPath}")
`.trim();
}

// ────────────────────────────────────────────────────────────────────────────
// Public generation entry point
// ────────────────────────────────────────────────────────────────────────────

/**
 * Generate an audio-driven lip-synced avatar video using LongCat-Avatar 1.5.
 *
 * @throws If the model isn't installed, the Python package is missing, or
 *         generation fails. The caller should fall back to the SVG renderer
 *         on error.
 */
export async function generateAvatarVideo(
  opts: AvatarOptions,
): Promise<AvatarResult> {
  // Ensure output directory exists
  mkdirSync(dirname(opts.outputPath), { recursive: true });

  const pythonPath = getPythonPath();
  const modelDir = getModelDir();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();

  const script = buildInferenceScript(opts, modelDir);

  // eslint-disable-next-line no-console
  console.log(
    `[mlxAvatar] LongCat-Avatar → ${pythonPath} ` +
    `image=${opts.referenceImage} audio=${opts.audioPath} → ${opts.outputPath}`,
  );

  return new Promise<AvatarResult>((pResolve, pReject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const child = execFile(
      pythonPath,
      ["-c", script],
      {
        maxBuffer: 1024 * 1024 * 512, // 512 MiB
        timeout: timeoutMs,
      },
    );

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      process.stdout.write(text);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      process.stderr.write(text);
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      pReject(
        new Error(
          `[mlxAvatar] timed out after ${timeoutMs}ms\n${stderr}`,
        ),
      );
    }, timeoutMs);

    child.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pReject(
        new Error(`[mlxAvatar] spawn error: ${err.message}\n${stderr}`),
      );
    });

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;

      if (code === 0) {
        pResolve({ outputPath: resolve(opts.outputPath), stdout, stderr, durationMs });
      } else if (signal) {
        pReject(
          new Error(
            `[mlxAvatar] killed by signal ${signal} after ${durationMs}ms\n${stderr}`,
          ),
        );
      } else {
        pReject(
          new Error(
            `[mlxAvatar] exited with code ${code} after ${durationMs}ms\n${stderr}`,
          ),
        );
      }
    });
  });
}

/**
 * Check if the LongCat-Avatar model and Python package are available.
 * Returns true if the model directory exists and the Python package
 * can be imported.
 */
export function isAvatarAvailable(): boolean {
  try {
    const modelDir = getModelDir();
    if (!existsSync(modelDir)) return false;

    const pythonPath = getPythonPath();
    // Quick probe — don't block for more than 3 seconds
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    const probe = spawnSync(pythonPath, ["-c", "import longcat_video_avatar"], {
      timeout: 3000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return probe.status === 0;
  } catch {
    return false;
  }
}
