import type { Shot } from "../types.js";
import type { ShotTimeline } from "../timeline.js";
import type { ResolvedRig } from "../assets.js";
import type { LipSyncTrack } from "../lipsync/types.js";

export interface RenderShotRequest {
  shot: Shot;
  timeline: ShotTimeline;
  rigs: Map<string, ResolvedRig>;
  lipSyncTracks: Map<string, LipSyncTrack>; // utteranceId → track
  width: number;
  height: number;
  fps: number;
  seed: number;
  outputFile: string; // .mp4
}

export interface RenderedShot {
  shotId: string;
  file: string;
  durationMs: number;
  frameCount: number;
  renderer: string;
}

export interface HeadlessRenderer {
  readonly id: string;
  renderShot(req: RenderShotRequest): Promise<RenderedShot>;
}
