import { log } from "./logger.js";
import { config } from "./config.js";
import { Storage } from "./storage.js";
import { EpisodeSchema, type Episode } from "./types.js";
import { generateSpeech } from "./stages/speech.js";
import { compileTimeline, type EpisodeTimeline } from "./timeline.js";
import { loadManifest, resolveRig, type RigManifest, type ResolvedRig } from "./assets.js";
import { svgCutoutRenderer } from "./renderers/svgCutout.js";
import { createMlxRenderer } from "./renderers/mlxRenderer.js";
import type { HeadlessRenderer } from "./renderers/types.js";
import { analyzeUtterance } from "./lipsync/analyze.js";
import { assembleEpisode, type AssemblyOptions } from "./stages/assemble2.js";
import { join } from "node:path";
import { readFileSync } from "node:fs";

export interface PipelineOptions {
  episodeFile: string;
  manifestFile: string;
  outputFile: string;
  width?: number;
  height?: number;
  fps?: number;
  musicFile?: string;
  seed?: number;
}

export interface PipelineResult {
  episode: Episode;
  timeline: EpisodeTimeline;
  outputFile: string;
  captionsFile: string;
  durationMs: number;
}

/**
 * Resolve which {@link HeadlessRenderer} to drive the per-shot render phase
 * with, based on `config.video.renderer` (set from the `RENDERER` env var).
 *
 *   - `"svg"` (default) → {@link svgCutoutRenderer}. Fully offline, zero
 *     external dependencies; the original behaviour.
 *   - `"mlx"`           → MLX Wan 2.2 / LTX-2 via the local `mlx-video`
 *     Python adapter. Constructed fresh so env vars (`MLX_BACKEND`,
 *     `MLX_MODEL`, …) are read at selection time, not module load. The MLX
 *     module defers all Python/venv resolution to `renderShot`, so simply
 *     importing it is side-effect free and gives a clear error path inside
 *     the renderer rather than at boot.
 *
 * Unknown values fall back to the SVG renderer with a warning, so a typo in
 * `RENDERER` never crashes the pipeline.
 */
export function selectRenderer(): HeadlessRenderer {
  const choice = config.video.renderer.trim().toLowerCase();
  switch (choice) {
    case "mlx":
      return createMlxRenderer();
    case "svg":
    default:
      if (choice && choice !== "svg") {
        log.warn(`Unknown renderer "${choice}"; falling back to svgCutout`);
      }
      return svgCutoutRenderer;
  }
}

/**
 * v2 production pipeline:
 *   episode.json → validate → speech → timeline → lip-sync → render → assemble
 */
export async function runPipelineV2(opts: PipelineOptions): Promise<PipelineResult> {
  log.info(`Loading episode: ${opts.episodeFile}`);
  const raw = JSON.parse(readFileSync(opts.episodeFile, "utf8"));
  const episode = EpisodeSchema.parse(raw);
  log.info(`Episode: "${episode.title}" (${episode.shots.length} shots, ${episode.cast.length} cast)`);

  log.info(`Loading manifest: ${opts.manifestFile}`);
  const manifest = loadManifest(opts.manifestFile);

  // Resolve rigs for all cast members
  const rigs = new Map<string, ResolvedRig>();
  for (const cast of episode.cast) {
    rigs.set(cast.characterId, resolveRig(manifest, cast.characterId));
  }
  log.info(`Rigs resolved: ${[...rigs.keys()].join(", ")}`);

  // Setup storage
  const outputDir = join(process.cwd(), config.outputDir);
  const storage = new Storage(outputDir);

  // Phase 1: Generate speech
  const { clips } = await generateSpeech(episode, storage);

  // Phase 2: Compile timeline
  const fps = opts.fps ?? 30;
  const timeline = compileTimeline(episode, clips, fps);
  log.info(`Timeline: ${timeline.totalFrames} frames, ${(timeline.totalMs / 1000).toFixed(1)}s`);

  // Phase 3: Lip-sync analysis (fallback for all utterances since Rhubarb isn't installed)
  const lipSyncTracks = new Map();
  for (const shot of episode.shots) {
    for (const line of shot.dialogue) {
      const clip = clips.get(line.id);
      if (!clip) continue;
      try {
        const track = await analyzeUtterance({
          utteranceId: line.id,
          speakerId: line.speakerId,
          text: line.text,
          audioPath: clip.file,
          mode: "auto",
        });
        lipSyncTracks.set(line.id, track);
      } catch (err) {
        log.info(`Lip-sync fallback for ${line.id}: ${(err as Error).message}`);
      }
    }
  }
  log.info(`Lip-sync tracks: ${lipSyncTracks.size}`);
  // Phase 4: Render each shot
  const shotClips: { file: string; timeline: any }[] = [];
  const width = opts.width ?? 1280;
  const height = opts.height ?? 720;
  const seed = opts.seed ?? 42;
  const renderer = selectRenderer();
  log.info(`Renderer: ${renderer.id} (RENDERER=${config.video.renderer})`);
  let shotIdx = 0;
  for (const shot of episode.shots) {
    const shotTimeline = timeline.shots[shotIdx]!;
    const shotFile = join(storage.root, `shots/${shot.id}.mp4`);

    log.info(`Rendering shot ${shotIdx + 1}/${episode.shots.length}: ${shot.id}`);
    const rendered = await renderer.renderShot({
      shot,
      timeline: shotTimeline,
      rigs,
      lipSyncTracks,
      width,
      height,
      fps,
      seed: seed + shotIdx,
      outputFile: shotFile,
    });

    shotClips.push({ file: rendered.file, timeline: shotTimeline });
    shotIdx++;
  }
  log.info(`Rendered ${shotClips.length} shots`);

  // Phase 5: Assembly
  const assemblyOpts: AssemblyOptions = {
    width,
    height,
    fps,
    musicFile: opts.musicFile,
    outputFile: opts.outputFile,
  };

  const result = await assembleEpisode(
    shotClips,
    episode,
    timeline,
    join(storage.root, "speech"),
    assemblyOpts,
  );

  return {
    episode,
    timeline,
    outputFile: result.file,
    captionsFile: result.captionsFile,
    durationMs: result.durationMs,
  };
}
