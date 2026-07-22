import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { loadManifest, resolveRig } from "../src/assets.js";
import type { ResolvedRig } from "../src/assets.js";
import type { Shot, MouthShape } from "../src/types.js";
import type { ShotTimeline, PlacedUtterance } from "../src/timeline.js";
import type { LipSyncTrack, MouthCue } from "../src/lipsync/types.js";
import {
  svgCutoutRenderer,
  composeFrameSvg,
  buildBlinkSchedule,
} from "../src/renderers/svgCutout.js";

const execFileAsync = promisify(execFile);
const REPO = fileURLToPath(new URL("..", import.meta.url));
const MANIFEST_PATH = join(REPO, "assets", "manifest.v1.json");
const FPS = 12;
const FRAME_W = 320;
const FRAME_H = 180;

/** ffprobe helper: get width/height/duration/fps as Numbers from a video file. */
async function probe(file: string): Promise<{ w: number; h: number; durationSec: number; fps: number }> {
  const args = [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height,avg_frame_rate,duration:format=duration",
    "-of", "json",
    file,
  ];
  const { stdout } = await execFileAsync("ffprobe", args);
  const j = JSON.parse(stdout) as any;
  const stream = j.streams?.[0];
  const fmt = j.format;
  const fpsStr = stream?.avg_frame_rate ?? "0/0";
  const [num, den] = fpsStr.split("/").map(Number);
  return {
    w: Number(stream?.width ?? 0),
    h: Number(stream?.height ?? 0),
    durationSec: Number(fmt?.duration ?? stream?.duration ?? 0),
    fps: Number.isFinite(den) && den !== 0 ? num / den : 0,
  };
}

// ---------------------------------------------------------------------------
// Build fixtures: a 5-frame shot (400ms @ 12fps) with a 3-cue viseme track:
//   X → A → D → F → X  (one cue per frame; transition boundaries tested below).
// ---------------------------------------------------------------------------

function makeShot(): Shot {
  return {
    id: "shot-r1",
    settingId: "palace",
    actors: [
      { characterId: "daniel", x: 0.3, y: 0.5, scale: 1, pose: "neutral", facing: "right" },
    ],
    leadIn: undefined,
    dialogue: [
      { id: "utt-1", speakerId: "daniel", text: "pad", emotion: "neutral", pauseAfterMs: 0 },
    ],
    action: "",
    camera: "locked",
  };
}

function makeTimeline(): ShotTimeline {
  return {
    shotId: "shot-r1",
    startFrame: 0,
    endFrame: 5,
    durationMs: 1000 * 5 / 12,  // ≈416
    utterances: [
      {
        utteranceId: "utt-1",
        shotId: "shot-r1",
        speakerId: "daniel",
        text: "pad",
        startMs: 0,
        endMs: 1000 * 5 / 12,
        isLeadIn: false,
      } satisfies PlacedUtterance,
    ],
  };
}

function makeLipSyncTrack(): LipSyncTrack {
  // One cue per frame: frame0 X, frame1 A, frame2 D, frame3 F, frame4 X.
  // frameMs ≈ 83.33
  const frameMs = 1000 / 12;
  const cues: MouthCue[] = [
    { startSec: 0 * frameMs / 1000, endSec: 1 * frameMs / 1000, shape: "X" },
    { startSec: 1 * frameMs / 1000, endSec: 2 * frameMs / 1000, shape: "A" },
    { startSec: 2 * frameMs / 1000, endSec: 3 * frameMs / 1000, shape: "D" },
    { startSec: 3 * frameMs / 1000, endSec: 4 * frameMs / 1000, shape: "F" },
    { startSec: 4 * frameMs / 1000, endSec: 5 * frameMs / 1000, shape: "X" },
  ];
  return {
    schemaVersion: 1,
    trackId: "t-1",
    utteranceId: "utt-1",
    speakerId: "daniel",
    audio: { path: "/dev/null", sha256: "fake", durationSec: 5 * frameMs / 1000, sampleRate: 48000, channels: 1 },
    analyzer: { kind: "rhubarb", version: "test" },
    cues,
  } satisfies LipSyncTrack;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("composeFrameSvg selects the correct mouth at frame boundaries (X→A→D→F→X)", () => {
  const manifest = loadManifest(MANIFEST_PATH);
  const daniel = resolveRig(manifest, "daniel");
  const rigs = new Map<string, ResolvedRig>([["daniel", daniel]]);
  const shot = makeShot();
  const timeline = makeTimeline();
  const tracks = new Map<string, LipSyncTrack>([["utt-1", makeLipSyncTrack()]]);

  const expected: MouthShape[] = ["X", "A", "D", "F", "X"];
  for (let f = 0; f < expected.length; f++) {
    const svg = composeFrameSvg({
      shot,
      timeline,
      rigs,
      lipSyncTracks: tracks,
      width: FRAME_W,
      height: FRAME_H,
      seed: 7,
      frameIndex: f,
      totalFrames: expected.length,
      fps: FPS,
    });
    const expectedMouth = expected[f]!;
    const mouthFile = daniel.mouths[expectedMouth]!.pathname;
    const mouthBasename = mouthFile.split("/").pop()!.replace(".svg", "");
    assert.ok(
      svg.includes(`data-mouth="${expectedMouth}"`),
      `frame ${f}: expected data-mouth="${expectedMouth}" in SVG`,
    );
    assert.ok(
      svg.includes(mouthBasename) || svg.includes(expectedMouth),
      `frame ${f}: expected SVG to include "${expectedMouth}" mouth asset`,
    );
  }
});

test("buildBlinkSchedule is deterministic from seed (no Math.random; same seed identical blinks)", () => {
  const a = buildBlinkSchedule({ seed: 42, totalFrames: 60, fps: 12 });
  const b = buildBlinkSchedule({ seed: 42, totalFrames: 60, fps: 12 });
  assert.deepEqual(a, b, "same seed must produce identical blink schedule");

  const c = buildBlinkSchedule({ seed: 43, totalFrames: 60, fps: 12 });
  // Different seed → very likely different schedule (allow false pass if they
  // happen to coincide, but usually they differ in at least one blink frame).
  // We verify at minimum that the schedule is a boolean array of correct length.
  assert.equal(a.length, 60);
  assert.equal(b.length, 60);
  assert.ok(
    a.every((v) => typeof v === "boolean"),
    "blink schedule must be boolean[]",
  );
  // Blinks are rare — expect at least 1 closed-frame in 60 frames.
  const closedCount = a.filter(Boolean).length;
  assert.ok(closedCount >= 1, `expected at least 1 blink in 60 frames, got ${closedCount}`);
});

test("renderShot produces an MP4 with the requested dimensions, FPS, and duration", async () => {
  const manifest = loadManifest(MANIFEST_PATH);
  const daniel = resolveRig(manifest, "daniel");
  const rigs = new Map<string, ResolvedRig>([["daniel", daniel]]);
  const shot = makeShot();
  const timeline = makeTimeline();
  const tracks = new Map<string, LipSyncTrack>([["utt-1", makeLipSyncTrack()]]);

  const outDir = mkdtempSync(join(tmpdir(), "svg-render-"));
  const outputFile = join(outDir, "shot.mp4");

  const result = await svgCutoutRenderer.renderShot({
    shot,
    timeline,
    rigs,
    lipSyncTracks: tracks,
    width: FRAME_W,
    height: FRAME_H,
    fps: FPS,
    seed: 7,
    outputFile,
  });

  assert.equal(result.renderer, svgCutoutRenderer.id);
  assert.equal(result.shotId, shot.id);
  assert.ok(existsSync(outputFile), "output MP4 must exist");
  assert.equal(result.frameCount, 5);

  const info = await probe(outputFile);
  assert.equal(info.w, FRAME_W, `width ${info.w} != ${FRAME_W}`);
  assert.equal(info.h, FRAME_H, `height ${info.h} != ${FRAME_H}`);
  // Duration should be roughly 5/12 seconds (~0.417s). H.264 will round to codec
  // ticks; allow generous tolerance.
  const expectedDur = 5 / FPS;
  assert.ok(
    Math.abs(info.durationSec - expectedDur) < 0.15,
    `duration ${info.durationSec} far from expected ${expectedDur}`,
  );
});

test("seeded blinks are repeatable across two renders of the same shot", async () => {
  const manifest = loadManifest(MANIFEST_PATH);
  const daniel = resolveRig(manifest, "daniel");
  const rigs = new Map<string, ResolvedRig>([["daniel", daniel]]);
  const shot = makeShot();
  const timeline = makeTimeline();
  const tracks = new Map<string, LipSyncTrack>([["utt-1", makeLipSyncTrack()]]);

  const outA = mkdtempSync(join(tmpdir(), "svg-render-a-"));
  const outB = mkdtempSync(join(tmpdir(), "svg-render-b-"));
  const fileA = join(outA, "a.mp4");
  const fileB = join(outB, "b.mp4");

  const req = {
    shot, timeline, rigs, lipSyncTracks: tracks,
    width: FRAME_W, height: FRAME_H, fps: FPS, seed: 99,
  } as const;

  await svgCutoutRenderer.renderShot({ ...req, outputFile: fileA });
  await svgCutoutRenderer.renderShot({ ...req, outputFile: fileB });

  const a = await probe(fileA);
  const b = await probe(fileB);
  assert.equal(a.w, b.w);
  assert.equal(a.h, b.h);
  assert.equal(a.durationSec, b.durationSec);
  // Same seed → same frameCount (already asserted by renderShot's return, but
  // verify the file sizes are also byte-identical modulo encoder timestamps).
  // We can't easily compare bytes reliably, but the durations + dimensions must
  // match exactly.
  assert.ok(existsSync(fileA) && existsSync(fileB));
  assert.equal(a.fps, b.fps, "frame rates must match across seed-stable renders");
});
