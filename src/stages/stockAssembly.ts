import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { config } from "../config.js";
import { log } from "../logger.js";
import { EdgeTtsProvider } from "../providers/edgeTts.js";
import {
  drawtextAvailable,
  escapeFontPath,
  ffmpeg,
  probeDuration,
  resolveCaptionFont,
  wrapCaption,
} from "../providers/ffmpeg.js";
import { Storage } from "../storage.js";
import { generateMusic } from "./music.js";

export const StockClipSchema = z.object({
  /** Filename relative to the manifest's clipsDir. */
  file: z.string().min(1),
  /** Narration spoken over this clip. Trimmed/padded to the clip's fixed duration. */
  narration: z.string().min(1).max(500),
  /** Burned caption text, if different from narration (defaults to narration). */
  caption: z.string().optional(),
});
export type StockClip = z.infer<typeof StockClipSchema>;

export const StockManifestSchema = z.object({
  title: z.string().min(1),
  /** Absolute or cwd-relative folder containing the clip files. */
  clipsDir: z.string().min(1),
  /** Music bed volume under the narration mix, 0-1. */
  musicVolume: z.number().min(0).max(1).default(0.7),
  /** edge-tts voice key (see providers/edgeTts.ts VOICE_MAP). Omit for default. */
  voice: z.string().optional(),
  /** Skip clips that are byte-identical to an earlier one in the list. */
  dedupe: z.boolean().default(true),
  clips: z.array(StockClipSchema).min(1),
});
export type StockManifest = z.infer<typeof StockManifestSchema>;

export interface StockAssemblyOptions {
  manifestPath: string;
  /** Burn captions if a font is available. Default true (degrades gracefully like the main pipeline). */
  captions?: boolean;
  /** Override the output directory slug (default: derived from title). */
  outSlug?: string;
}

function md5(path: string): string {
  return createHash("md5").update(readFileSync(path)).digest("hex");
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

/**
 * Stitches pre-existing / licensed stock footage (e.g. downloaded 3D
 * animation clips) into a narrated episode, reusing the same offline TTS,
 * music-bed, and caption primitives as the main generative pipeline.
 *
 * Key structural difference from the main pipeline: clip duration is fixed
 * by the source footage, so narration is trimmed/padded to fit rather than
 * driving clip length (the inverse of voiceover-then-animate ordering).
 */
export async function assembleFromStockClips(opts: StockAssemblyOptions): Promise<string> {
  const raw = JSON.parse(readFileSync(opts.manifestPath, "utf8"));
  const manifest = StockManifestSchema.parse(raw);

  log.stage(`Stock assembly: "${manifest.title}"`);

  const slug = opts.outSlug ?? slugify(manifest.title);
  const id = `${new Date().toISOString().slice(0, 10)}-${slug}`;
  const storage = new Storage(id);

  // ── Resolve + dedupe clips by content hash ──
  const seen = new Map<string, string>(); // md5 -> first file that had it
  const resolved: Array<{ path: string; file: string; narration: string; caption: string }> = [];
  for (const c of manifest.clips) {
    const clipPath = resolve(manifest.clipsDir, c.file);
    if (!existsSync(clipPath)) throw new Error(`Clip not found: ${clipPath}`);
    if (manifest.dedupe) {
      const hash = md5(clipPath);
      const dupe = seen.get(hash);
      if (dupe) {
        log.warn(`"${c.file}" is byte-identical to "${dupe}" — skipping duplicate.`);
        continue;
      }
      seen.set(hash, c.file);
    }
    resolved.push({ path: clipPath, file: c.file, narration: c.narration, caption: c.caption ?? c.narration });
  }
  if (resolved.length === 0) throw new Error("No clips remain after dedupe — check the manifest.");
  log.ok(`${resolved.length} unique clip(s) (${manifest.clips.length} listed).`);

  // ── Per-clip: probe fixed duration, render narration, fit to duration ──
  const edgeTts = new EdgeTtsProvider();
  const audioDir = storage.dir("audio");
  const segDir = storage.dir("segments");
  const font = resolveCaptionFont();
  const canCaption = opts.captions !== false && (await drawtextAvailable()) && !!font;
  if (opts.captions !== false && !canCaption) {
    log.warn("drawtext filter or caption font unavailable — assembling without burned captions.");
  }
  const capDir = canCaption ? storage.dir("captions") : "";

  const segments: string[] = [];
  let totalDuration = 0;

  for (let i = 0; i < resolved.length; i++) {
    const clip = resolved[i]!;
    const clipDur = await probeDuration(clip.path);
    if (!clipDur) throw new Error(`Could not read duration for ${clip.path}`);

    const rawNarration = `${audioDir}/narr-${String(i).padStart(2, "0")}.mp3`;
    await edgeTts.generate(clip.narration, rawNarration, manifest.voice);
    const narrDur = (await probeDuration(rawNarration)) || 0;
    if (narrDur > clipDur) {
      log.warn(
        `Scene ${i} ("${clip.file}"): narration ${narrDur.toFixed(1)}s exceeds clip length ${clipDur.toFixed(1)}s — ` +
          `audio will be cut off. Shorten the narration or split the clip.`,
      );
    }

    // Pad (or hard-trim) narration to exactly the clip's fixed duration so
    // audio and video concat cleanly with no drift across scenes.
    const paddedNarration = `${audioDir}/narr-${String(i).padStart(2, "0")}-padded.m4a`;
    await ffmpeg([
      "-i", rawNarration,
      "-af", `apad=whole_dur=${clipDur.toFixed(2)}`,
      "-t", clipDur.toFixed(2),
      "-c:a", "aac", "-b:a", "192k",
      paddedNarration,
    ]);

    const seg = `${segDir}/seg-${String(i).padStart(2, "0")}.mp4`;
    const scalePad =
      `scale=${config.width}:${config.height}:force_original_aspect_ratio=decrease,` +
      `pad=${config.width}:${config.height}:(ow-iw)/2:(oh-ih)/2`;

    if (canCaption) {
      const capFile = `${capDir}/scene-${String(i).padStart(2, "0")}.txt`;
      writeFileSync(capFile, wrapCaption(clip.caption));
      const fontSize = Math.round(config.height * 0.042);
      const drawtext =
        `drawtext=fontfile=${escapeFontPath(font!)}:textfile=${capFile}:expansion=none:` +
        `fontcolor=white:fontsize=${fontSize}:line_spacing=10:` +
        `box=1:boxcolor=0x000000A0:boxborderw=26:` +
        `x=(w-text_w)/2:y=h-text_h-(h*0.07)`;
      await ffmpeg([
        "-i", clip.path,
        "-i", paddedNarration,
        "-filter_complex", `[0:v]${scalePad},${drawtext}[v]`,
        "-map", "[v]", "-map", "1:a",
        "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
        "-r", String(config.fps),
        "-c:a", "aac", "-ar", "44100", "-ac", "2",
        "-shortest",
        seg,
      ]);
    } else {
      await ffmpeg([
        "-i", clip.path,
        "-i", paddedNarration,
        "-vf", scalePad,
        "-map", "0:v:0", "-map", "1:a",
        "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
        "-r", String(config.fps),
        "-c:a", "aac", "-ar", "44100", "-ac", "2",
        "-shortest",
        seg,
      ]);
    }
    segments.push(seg);
    totalDuration += clipDur;
    log.ok(`Scene ${i + 1}/${resolved.length}: ${clip.file} (${clipDur.toFixed(1)}s)`);
  }

  // ── Concat all narrated segments ──
  const listFile = storage.path("concat.txt");
  writeFileSync(listFile, segments.map((s) => `file '${s}'`).join("\n"));
  const joined = storage.path("joined.mp4");
  await ffmpeg(["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", joined]);

  // ── Music bed — reuses the main pipeline's offline generator (or Suno if configured) ──
  const music = await generateMusic(totalDuration, storage);

  // ── Final mix ──
  const final = storage.path("episode.mp4");
  await ffmpeg([
    "-i", joined,
    "-i", music,
    "-filter_complex",
    `[1:a]volume=${manifest.musicVolume}[m];[0:a][m]amix=inputs=2:duration=first:normalize=0[a]`,
    "-map", "0:v", "-map", "[a]",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
    final,
  ]);

  log.ok(`Stock episode assembled: ${final} (${totalDuration.toFixed(1)}s)`);
  return final;
}
