import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { assembleEpisode, type AssemblyOptions } from "../src/stages/assemble2.js";
import type { Episode } from "../src/types.js";
import { compileTimeline } from "../src/timeline.js";
import type { SpeechClip } from "../src/providers/speech.js";

/** Minimal 2-shot episode for assembly testing. */
function testEpisode(): Episode {
  return {
    schemaVersion: 2,
    title: "Assembly Test",
    source: "Test",
    lesson: "test",
    cast: [
      { characterId: "daniel", rigId: "rig:daniel", voiceId: "voice:daniel" },
    ],
    shots: [
      {
        id: "s1",
        settingId: "palace",
        actors: [{ characterId: "daniel", x: 0.5, y: 0.5, scale: 1, pose: "neutral", facing: "right" }],
        dialogue: [
          { id: "a1", speakerId: "daniel", text: "Hello world.", emotion: "joy", pauseAfterMs: 200 },
        ],
        action: "",
        camera: "locked",
      },
      {
        id: "s2",
        settingId: "palace",
        actors: [{ characterId: "daniel", x: 0.5, y: 0.5, scale: 1, pose: "neutral", facing: "right" }],
        dialogue: [
          { id: "a2", speakerId: "daniel", text: "Goodbye world.", emotion: "neutral", pauseAfterMs: 200 },
        ],
        action: "",
        camera: "push-in",
      },
    ],
  };
}

function testClips(): Map<string, SpeechClip> {
  const clips = new Map<string, SpeechClip>();
  clips.set("a1", { utteranceId: "a1", file: "/tmp/a1.wav", durationMs: 900 });
  clips.set("a2", { utteranceId: "a2", file: "/tmp/a2.wav", durationMs: 1100 });
  return clips;
}

/** Generate short silent video clips for testing. */
function generateTestClips(dir: string, timeline: ReturnType<typeof compileTimeline>) {
  const clips: { file: string; timeline: any }[] = [];
  for (const shot of timeline.shots) {
    const clipFile = join(dir, `${shot.shotId}.mp4`);
    const dur = shot.durationMs / 1000;
    execSync(`ffmpeg -y -f lavfi -i color=c=blue:s=320x180:d=${dur} -c:v libx264 -pix_fmt yuv420p "${clipFile}"`);
    clips.push({ file: clipFile, timeline: shot });
  }
  return clips;
}

/** Generate test speech WAVs using fixture provider. */
function generateTestSpeech(dir: string) {
  const speechDir = join(dir, "speech");
  execSync(`mkdir -p "${speechDir}"`);
  for (const id of ["a1", "a2"]) {
    const wavPath = join(speechDir, `${id}.wav`);
    // Generate 1s silent WAV
    execSync(`ffmpeg -y -f lavfi -i anullsrc=channel_layout=mono:sample_rate=48000:d=1 -c:a pcm_s16le "${wavPath}"`);
  }
  return speechDir;
}

test("assembleEpisode produces an MP4 with correct duration and SRT captions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "assembly-test-"));
  const episode = testEpisode();
  const clips = testClips();
  const timeline = compileTimeline(episode, clips, 30);
  
  const shotClips = generateTestClips(dir, timeline);
  const speechDir = generateTestSpeech(dir);
  
  const outputFile = join(dir, "episode.mp4");
  const options: AssemblyOptions = {
    width: 320,
    height: 180,
    fps: 30,
    outputFile,
  };
  
  const result = await assembleEpisode(shotClips, episode, timeline, speechDir, options);
  
  assert.equal(result.file, outputFile);
  assert.ok(existsSync(outputFile), "episode MP4 exists");
  assert.ok(existsSync(result.captionsFile), "SRT captions exist");
  
  // Verify SRT has 2 captions
  const srt = readFileSync(result.captionsFile, "utf8");
  assert.ok(srt.includes("Hello world."), "SRT contains first line");
  assert.ok(srt.includes("Goodbye world."), "SRT contains second line");
  
  // Verify ffprobe duration is roughly correct
  // Total: 900 + 200 + 1100 + 200 = 2400ms = 2.4s
  const probe = execSync(
    `ffprobe -v error -show_entries format=duration -of csv=p=0 "${outputFile}"`,
    { encoding: "utf8" },
  ).trim();
  const dur = parseFloat(probe);
  assert.ok(Math.abs(dur - 2.4) < 0.3, `duration ~2.4s (got ${dur}s)`);
  
  rmSync(dir, { recursive: true, force: true });
});

test("assembleEpisode generates valid ASS subtitles for burn-in", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ass-test-"));
  const episode = testEpisode();
  const clips = testClips();
  const timeline = compileTimeline(episode, clips, 30);
  
  const shotClips = generateTestClips(dir, timeline);
  const speechDir = generateTestSpeech(dir);
  
  const outputFile = join(dir, "episode.mp4");
  const assFile = join(dir, "episode.ass");
  
  const result = await assembleEpisode(shotClips, episode, timeline, speechDir, {
    width: 320,
    height: 180,
    fps: 30,
    outputFile,
  });
  
  // ASS file should exist and have proper structure
  const ass = readFileSync(assFile, "utf8");
  assert.ok(ass.includes("[Script Info]"), "ASS has Script Info header");
  assert.ok(ass.includes("[V4+ Styles]"), "ASS has V4+ Styles section");
  assert.ok(ass.includes("[Events]"), "ASS has Events section");
  assert.ok(ass.includes("Hello world."), "ASS contains first dialogue line");
  assert.ok(ass.includes("daniel:"), "ASS includes speaker label");
  
  rmSync(dir, { recursive: true, force: true });
});
