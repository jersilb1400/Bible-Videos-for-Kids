import { spawn } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import type { HeadlessRenderer, RenderShotRequest, RenderedShot } from "./types.js";
import type { Shot, MouthShape } from "../types.js";
import type { ShotTimeline, PlacedUtterance } from "../timeline.js";
import type { ResolvedRig } from "../assets.js";
import type { LipSyncTrack, MouthCue } from "../lipsync/types.js";

// ────────────────────────────────────────────────────────────────────────────
// Deterministic PRNG (mulberry32) — no Math.random, repeatable across runs.
// ────────────────────────────────────────────────────────────────────────────
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Viseme lookup: find the active MouthCue at a given time.
// ────────────────────────────────────────────────────────────────────────────
function visemeAt(track: LipSyncTrack, tSec: number): MouthShape {
  for (const cue of track.cues) {
    if (tSec >= cue.startSec && tSec < cue.endSec) {
      return cue.shape;
    }
  }
  return "X"; // rest
}

// ────────────────────────────────────────────────────────────────────────────
// Blink schedule: deterministic per-character, ~once every 3-5 seconds,
// each blink lasting ~150ms (4-5 frames at 30fps).
// ────────────────────────────────────────────────────────────────────────────
interface Blink {
  startSec: number;
  endSec: number;
}

function generateBlinkSchedule(seed: number, durationSec: number): Blink[] {
  const rng = mulberry32(seed);
  const blinks: Blink[] = [];
  let t = 1.5 + rng() * 2; // first blink at 1.5-3.5s
  while (t < durationSec) {
    blinks.push({ startSec: t, endSec: t + 0.15 });
    t += 2.5 + rng() * 2.5; // next blink in 2.5-5s
  }
  return blinks;
}

function isBlinking(blinks: Blink[], tSec: number): boolean {
  for (const b of blinks) {
    if (tSec >= b.startSec && tSec < b.endSec) return true;
  }
  return false;
}

// ────────────────────────────────────────────────────────────────────────────
// Camera motion: apply transform to the background based on shot.camera.
// ────────────────────────────────────────────────────────────────────────────
function cameraTransform(camera: string, progress: number, width: number, height: number): string {
  // progress: 0 at start, 1 at end of shot
  switch (camera) {
    case "push-in": {
      // Scale from 1.0 to 1.15 over the shot, centered
      const scale = 1.0 + 0.15 * progress;
      const cx = width / 2;
      const cy = height / 2;
      return `transform="translate(${cx} ${cy}) scale(${scale}) translate(${-cx} ${-cy})"`;
    }
    case "pan-left": {
      // Translate from 0 to -5% of width
      const offset = -width * 0.05 * progress;
      return `transform="translate(${offset} 0)"`;
    }
    case "pan-right": {
      const offset = width * 0.05 * progress;
      return `transform="translate(${offset} 0)"`;
    }
    default:
      return "";
  }
}

// ────────────────────────────────────────────────────────────────────────────
// SVG composition: layer background + character bodies + mouths + eyes.
// ────────────────────────────────────────────────────────────────────────────
function composeFrameSVG(
  shot: Shot,
  req: RenderShotRequest,
  rigs: Map<string, ResolvedRig>,
  lipSyncTracks: Map<string, LipSyncTrack>,
  utterances: PlacedUtterance[],
  shotStartMs: number,
  frameMs: number,
  blinkSchedules: Map<string, Blink[]>,
): string {
  const { width, height } = req;
  const frameSec = (frameMs - shotStartMs) / 1000;

  // Find the active utterance at this frame time (episode-relative ms)
  const episodeMs = frameMs;
  let activeUtterance: PlacedUtterance | null = null;
  for (const u of utterances) {
    if (episodeMs >= u.startMs && episodeMs < u.endMs) {
      activeUtterance = u;
      break;
    }
  }

  // Background SVG (from manifest or settingId)
  const bgSvg = loadSVGLayer(req.rigs, "__background__", shot.settingId, width, height);

  // Camera transform
  const progress = req.timeline.durationMs > 0
    ? (frameMs - shotStartMs) / req.timeline.durationMs
    : 0;
  const camTransform = cameraTransform(shot.camera, Math.min(1, Math.max(0, progress)), width, height);

  // Character layers
  const characterLayers: string[] = [];
  for (const actor of shot.actors) {
    const rig = rigs.get(actor.characterId);
    if (!rig) continue;

    // Determine mouth shape
    let mouthShape: MouthShape = "X";
    if (activeUtterance && activeUtterance.speakerId === actor.characterId && !activeUtterance.isLeadIn) {
      const track = lipSyncTracks.get(activeUtterance.utteranceId);
      if (track) {
        // Utterance-local time
        const utteranceSec = (episodeMs - activeUtterance.startMs) / 1000;
        mouthShape = visemeAt(track, utteranceSec);
      }
    }

    // Load body SVG
    const bodySvg = readFileSync(rig.body.pathname, "utf8");
    // Extract inner content (strip <?xml> and <svg> wrapper)
    const bodyInner = extractInnerSVG(bodySvg);

    // Load mouth SVG
    const mouthPath = (rig.mouths[mouthShape] ?? rig.mouths["X"])?.pathname;
    let mouthInner = "";
    if (mouthPath && existsSync(mouthPath)) {
      const mouthSvg = readFileSync(mouthPath, "utf8");
      mouthInner = extractInnerSVG(mouthSvg);
    }

    // Load eyes SVG (open or closed based on blink)
    const blinks = blinkSchedules.get(actor.characterId) ?? [];
    const eyesAreClosed = isBlinking(blinks, frameSec);
    const eyesPath = (eyesAreClosed ? rig.eyes.closed : rig.eyes.open).pathname;
    let eyesInner = "";
    if (existsSync(eyesPath)) {
      const eyesSvg = readFileSync(eyesPath, "utf8");
      eyesInner = extractInnerSVG(eyesSvg);
    }

    // Position character on stage
    // actor.x, actor.y are [0,1] normalized; scale is a multiplier
    // Character SVG viewBox is 400x600; we scale to fit ~40% of frame height
    const charHeight = height * 0.4 * actor.scale;
    const charWidth = charHeight * (400 / 600); // maintain aspect ratio
    const charX = actor.x * (width - charWidth);
    // y positions the ground point; character is drawn from top so adjust
    const charY = actor.y * (height - charHeight);

    // Flip if facing left
    const flipTransform = actor.facing === "left"
      ? `translate(${charX + charWidth} ${charY}) scale(-1 1)`
      : `translate(${charX} ${charY})`;

    characterLayers.push(
      `<g data-character="${actor.characterId}" data-mouth="${mouthShape}" transform="${flipTransform}">` +
      bodyInner +
      eyesInner +
      mouthInner +
      `</g>`
    );
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="${width}" height="${height}" fill="#1a1a2e"/>` +
    `<g ${camTransform}>` +
      extractInnerSVG(bgSvg) +
      characterLayers.join("") +
    `</g>` +
    `</svg>`;
}

function loadSVGLayer(
  rigs: Map<string, ResolvedRig>,
  key: string,
  settingId: string,
  width: number,
  height: number,
): string {
  // Try to find a background SVG matching settingId
  // Settings like "setting:palace" → backgrounds/palace.svg
  const bgKey = settingId.replace(/^setting:/, "").replace(/^bg:/, "");
  // Look for a rig manifest background
  for (const rig of rigs.values()) {
    // Check if the rig has a backgrounds map (it doesn't directly, but the manifest does)
    // For now, use the asset directory
    const bgPath = join(dirname(rig.body.pathname), "..", "backgrounds", `${bgKey}.svg`);
    if (existsSync(bgPath)) {
      return readFileSync(bgPath, "utf8");
    }
  }
  // Fallback: solid color background
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#2a2a4e"/></svg>`;
}

/** Extract the inner content of an SVG file (strip XML declaration and svg wrapper). */
function extractInnerSVG(svg: string): string {
  // Remove <?xml ...?> declaration
  let s = svg.replace(/<\?xml[^>]*\?>\s*/g, "");
  // Remove <svg ...> and </svg>
  s = s.replace(/<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  return s.trim();
}

// ────────────────────────────────────────────────────────────────────────────
// SVG cut-out renderer implementation.
// ────────────────────────────────────────────────────────────────────────────
export class SvgCutoutRenderer implements HeadlessRenderer {
  readonly id = "svg-cutout";

  async renderShot(req: RenderShotRequest): Promise<RenderedShot> {
    mkdirSync(dirname(req.outputFile), { recursive: true });

    const { shot, timeline, rigs, lipSyncTracks, fps, seed } = req;
    const frameCount = timeline.endFrame - timeline.startFrame;
    const shotStartMs = 0; // shot-local time for frame generation

    // Pre-generate blink schedules per character
    const blinkSchedules = new Map<string, Blink[]>();
    for (const actor of shot.actors) {
      const charSeed = seed + actor.characterId.charCodeAt(0);
      blinkSchedules.set(
        actor.characterId,
        generateBlinkSchedule(charSeed, timeline.durationMs / 1000),
      );
    }

    // Render each frame
    const frameDir = dirname(req.outputFile);
    const framePattern = join(frameDir, `.frame-${shot.id}-%06d.png`);

    for (let f = 0; f < frameCount; f++) {
      const frameMs = Math.round((f / fps) * 1000);
      const svg = composeFrameSVG(
        shot,
        req,
        rigs,
        lipSyncTracks,
        timeline.utterances,
        shotStartMs,
        frameMs,
        blinkSchedules,
      );

      // Rasterize SVG to PNG
      const resvg = new Resvg(svg, {
        fitTo: { mode: "width", value: req.width },
      });
      const pngBuffer = resvg.render().asPng();
      const framePath = join(frameDir, `.frame-${shot.id}-${String(f + 1).padStart(6, "0")}.png`);
      writeFileSync(framePath, pngBuffer);
    }

    // Encode frames to silent H.264 MP4
    await this.encodeFrames(framePattern, req.outputFile, fps, frameCount, req.width, req.height);

    // Cleanup frame PNGs
    for (let f = 1; f <= frameCount; f++) {
      const framePath = join(frameDir, `.frame-${shot.id}-${String(f).padStart(6, "0")}.png`);
      try { unlinkSync(framePath); } catch { /* may already be gone */ }
    }

    return {
      shotId: shot.id,
      file: req.outputFile,
      durationMs: timeline.durationMs,
      frameCount,
      renderer: this.id,
    };
  }

  private async encodeFrames(
    framePattern: string,
    outputFile: string,
    fps: number,
    frameCount: number,
    width: number,
    height: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const ff = spawn("ffmpeg", [
        "-y",
        "-framerate", String(fps),
        "-i", framePattern,
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-preset", "fast",
        "-crf", "18",
        "-movflags", "+faststart",
        "-frames:v", String(frameCount),
        outputFile,
      ]);
      let stderr = "";
      ff.stderr.on("data", (d) => (stderr += d));
      ff.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`ffmpeg encode failed (${code}): ${stderr}`));
        } else {
          resolve();
        }
      });
      ff.on("error", reject);
    });
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Public module surface
// ────────────────────────────────────────────────────────────────────────────

/** Shared singleton instance — the task's canonical `svgCutoutRenderer`
 * export. Construct once so callers can pass the same renderer object around
 * without per-call construction. */
export const svgCutoutRenderer: HeadlessRenderer = new SvgCutoutRenderer();

/** Argument shape for {@link composeFrameSvg}. */
export interface ComposeFrameSvgOptions {
  shot: Shot;
  timeline: ShotTimeline;
  rigs: Map<string, ResolvedRig>;
  lipSyncTracks: Map<string, LipSyncTrack>;
  width: number;
  height: number;
  seed: number;
  /** Zero-indexed frame position within this shot. */
  frameIndex: number;
  /** Total frames in the shot (used for camera progress + blink context). */
  totalFrames: number;
  /** Optional fps override; defaults to the timeline-implicit rate (24). */
  fps?: number;
}

/**
 * Compose a single frame's SVG string. Exposed as a public function so tests
 * can inspect the layered SVG (e.g. confirm the right mouth viseme was selected)
 * without rasterising. Calls the internal {@link composeFrameSVG} after
 * deriving per-character blink schedules from `seed`.
 */
export function composeFrameSvg(opts: ComposeFrameSvgOptions): string {
  const fps = opts.fps ?? 24;
  const shotDurationSec = opts.timeline.durationMs / 1000;
  // Use un-rounded float ms so viseme cue boundaries derived from the same
  // `frameIndex/fps` arithmetic align with the cue interval checks. Rounding
  // to integer ms would shift the lookup by up to 1/fps/2 seconds, which can
  // cross a cue boundary and select the wrong viseme.
  const frameMs = (opts.frameIndex / fps) * 1000;
  const shotStartMs = 0;
  // Reusable fake req carrying the cross-cut fields composeFrameSVG needs.
  const req: RenderShotRequest = {
    shot: opts.shot,
    timeline: opts.timeline,
    rigs: opts.rigs,
    lipSyncTracks: opts.lipSyncTracks,
    width: opts.width,
    height: opts.height,
    fps,
    seed: opts.seed,
    outputFile: "" as string,
  };
  // Pre-generate blink schedules per character — same algorithm as the
  // renderer, so what the test sees is bit-identical to a real render.
  const blinkSchedules = new Map<string, Blink[]>();
  for (const actor of opts.shot.actors) {
    const charSeed = opts.seed + actor.characterId.charCodeAt(0);
    blinkSchedules.set(actor.characterId, generateBlinkSchedule(charSeed, shotDurationSec));
  }
  return composeFrameSVG(
    opts.shot,
    req,
    opts.rigs,
    opts.lipSyncTracks,
    opts.timeline.utterances,
    shotStartMs,
    frameMs,
    blinkSchedules,
  );
}

/** Argument shape for {@link buildBlinkSchedule}. */
export interface BlinkScheduleOptions {
  /** Deterministic seed (no Math.random). */
  seed: number;
  /** Number of frames the schedule should cover. */
  totalFrames: number;
  /** Frames per second — needed to convert blink intervals into frame booleans. */
  fps: number;
}

/**
 * Build a per-frame boolean blink schedule: `true` at frames where the
 * character's eyes are closed, `false` where open. Deterministic — the same
 * `(seed, totalFrames, fps)` always returns the same array. Derived from the
 * same {@link generateBlinkSchedule} the renderer uses internally, so test
 * expectations match on-screen output frame-for-frame.
 */
export function buildBlinkSchedule(opts: BlinkScheduleOptions): boolean[] {
  const durationSec = opts.totalFrames / opts.fps;
  const blinks = generateBlinkSchedule(opts.seed, durationSec);
  const out: boolean[] = new Array(opts.totalFrames);
  for (let f = 0; f < opts.totalFrames; f++) {
    const t = f / opts.fps;
    out[f] = isBlinking(blinks, t);
  }
  return out;
}
