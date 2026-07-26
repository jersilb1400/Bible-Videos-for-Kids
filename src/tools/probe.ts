/**
 * probe — ffprobe wrapper for pipeline output validation.
 *
 * Provides structured probes for video/audio artifacts:
 * - Duration (seconds)
 * - Stream count & codec info
 * - Video dimensions
 * - Audio loudness (EBU R128, if available)
 * - File hash (SHA-256, for determinism checks)
 *
 * Used by proof-contract tests and pipeline QC.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { ffprobeBin } from "../providers/ffmpeg.js";

export interface ProbeResult {
  /** File path */
  file: string;
  /** Duration in seconds */
  durationSec: number;
  /** Video codec (e.g., "h264") */
  videoCodec: string | null;
  /** Audio codec (e.g., "aac") */
  audioCodec: string | null;
  /** Video width */
  width: number | null;
  /** Video height */
  height: number | null;
  /** Frame count reported by ffprobe */
  frameCount: number | null;
  /** Frame rate (fps) */
  fps: number | null;
  /** Audio sample rate */
  sampleRate: number | null;
  /** EBU R128 integrated loudness (dB) — null if not available */
  loudnessDb: number | null;
  /** File size in bytes */
  fileSize: number;
  /** SHA-256 hash (hex) */
  hash: string;
}

/** Probe a media file and return structured metadata. */
export function probe(file: string): ProbeResult {
  const stat = statSync(file);

  // Hash
  const hash = createHash("sha256");
  hash.update(readFileSync(file));
  const hashHex = hash.digest("hex");

  // ffprobe for streams
  const raw = spawnSync(ffprobeBin(), [
    "-v", "error",
    "-show_format",
    "-show_streams",
    "-of", "json",
    file,
  ]);

  if (raw.status !== 0 || !raw.stdout.length) {
    throw new Error(`ffprobe failed for ${file}: ${raw.stderr.toString()}`);
  }

  const json = JSON.parse(raw.stdout.toString());

  let videoCodec: string | null = null;
  let audioCodec: string | null = null;
  let width: number | null = null;
  let height: number | null = null;
  let fps: number | null = null;
  let sampleRate: number | null = null;
  let frameCount: number | null = null;
  let durationSec: number | null = null;

  const streams = json.streams ?? [];
  for (const s of streams) {
    if (s.codec_type === "video") {
      videoCodec = s.codec_name ?? null;
      width = s.width ?? null;
      height = s.height ?? null;
      if (s.r_frame_rate) {
        const [num, den] = s.r_frame_rate.split("/").map(Number);
        fps = den && den > 0 ? num / den : null;
      }
      frameCount = s.nb_frames ?? null;
    } else if (s.codec_type === "audio") {
      audioCodec = s.codec_name ?? null;
      sampleRate = s.sample_rate ?? null;
    }
  }

  // Duration from format level
  if (json.format?.duration) {
    durationSec = parseFloat(json.format.duration);
  }

  // If frame count not available from streams, compute from duration + fps
  if (frameCount === null && durationSec && fps) {
    frameCount = Math.round(durationSec * fps);
  }

  return {
    file,
    durationSec: durationSec ?? 0,
    videoCodec,
    audioCodec,
    width,
    height,
    fps,
    sampleRate,
    loudnessDb: null, // TODO: EBU R128 loudnorm filter
    fileSize: stat.size,
    hash: hashHex,
    frameCount,
  };
}

/** Probe audio loudness (EBU R128 integrated). Returns dB or null on failure. */
export async function probeLoudness(file: string): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(ffprobeBin(), [
      "-v", "error",
      "-of", "default=noprint_wrappers=1:nokey=1",
      "-af", "loudnorm=print_format=json",
      "-f", "null", "-",
      file,
    ]);
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("close", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      try {
        const json = JSON.parse(out);
        resolve(json.input_i ?? null);
      } catch {
        resolve(null);
      }
    });
    child.on("error", () => resolve(null));
  });
}