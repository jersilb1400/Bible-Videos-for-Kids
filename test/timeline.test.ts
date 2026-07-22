import assert from "node:assert/strict";
import { test } from "node:test";
import { compileTimeline, type EpisodeTimeline, type ShotTimeline, type PlacedUtterance } from "../src/timeline.js";
import type { Episode } from "../src/types.js";
import type { SpeechClip } from "../src/providers/speech.js";

/** Minimal episode with 2 shots and 3 dialogue lines. */
function testEpisode(): Episode {
  return {
    schemaVersion: 2,
    title: "Test",
    source: "Test 1",
    lesson: "test",
    cast: [
      { characterId: "daniel", rigId: "rig:daniel", voiceId: "voice:daniel" },
      { characterId: "darius", rigId: "rig:darius", voiceId: "voice:darius" },
    ],
    shots: [
      {
        id: "shot-1",
        settingId: "setting:room",
        actors: [{ characterId: "daniel", x: 0.5, y: 0.5, scale: 1, pose: "neutral", facing: "right" }],
        leadIn: { text: "Daniel prayed.", pauseAfterMs: 400 },
        dialogue: [
          { id: "line-1", speakerId: "daniel", text: "Hello God.", emotion: "joy", pauseAfterMs: 300 },
        ],
        action: "",
        camera: "locked",
      },
      {
        id: "shot-2",
        settingId: "setting:palace",
        actors: [{ characterId: "darius", x: 0.5, y: 0.5, scale: 1, pose: "neutral", facing: "right" }],
        dialogue: [
          { id: "line-2", speakerId: "darius", text: "What is this?", emotion: "wonder", pauseAfterMs: 500 },
          { id: "line-3", speakerId: "darius", text: "Amazing!", emotion: "joy", pauseAfterMs: 200 },
        ],
        action: "",
        camera: "push-in",
      },
    ],
  };
}

/** Mock speech clips with known durations. */
function testClips(): Map<string, SpeechClip> {
  const clips = new Map<string, SpeechClip>();
  clips.set("shot-1-leadin", { utteranceId: "shot-1-leadin", file: "/tmp/a.wav", durationMs: 1000 });
  clips.set("line-1", { utteranceId: "line-1", file: "/tmp/b.wav", durationMs: 2000 });
  clips.set("line-2", { utteranceId: "line-2", file: "/tmp/c.wav", durationMs: 1500 });
  clips.set("line-3", { utteranceId: "line-3", file: "/tmp/d.wav", durationMs: 1000 });
  return clips;
}

test("compileTimeline produces correct utterance timings from known clip durations", () => {
  const ep = testEpisode();
  const clips = testClips();
  const timeline = compileTimeline(ep, clips, 30);

  // Shot 1: leadIn(1000ms) + pause(400ms) + line-1(2000ms) + pause(300ms) = 3700ms
  // Shot 2: line-2(1500ms) + pause(500ms) + line-3(1000ms) + pause(200ms) = 3200ms
  // Total: 6900ms

  assert.equal(timeline.shots.length, 2);
  assert.equal(timeline.shots[0]!.shotId, "shot-1");
  assert.equal(timeline.shots[1]!.shotId, "shot-2");

  // Shot 1 timing
  const s1 = timeline.shots[0]!;
  assert.equal(s1.durationMs, 3700);
  assert.equal(s1.startFrame, 0);
  assert.equal(s1.endFrame, Math.ceil(3700 * 30 / 1000)); // 111

  // Shot 2 timing
  const s2 = timeline.shots[1]!;
  assert.equal(s2.durationMs, 3200);
  assert.equal(s2.startFrame, 111);

  // Utterance timings
  const u0 = s1.utterances[0]!; // leadIn
  assert.equal(u0.startMs, 0);
  assert.equal(u0.endMs, 1000);
  assert.equal(u0.isLeadIn, true);

  const u1 = s1.utterances[1]!; // line-1
  assert.equal(u1.startMs, 1400); // after leadIn 1000 + pause 400
  assert.equal(u1.endMs, 3400); // 1400 + 2000
  assert.equal(u1.isLeadIn, false);

  const u2 = s2.utterances[0]!; // line-2
  assert.equal(u2.startMs, 3700); // after shot-1 total
  assert.equal(u2.endMs, 5200); // 3700 + 1500

  const u3 = s2.utterances[1]!; // line-3
  assert.equal(u3.startMs, 5700); // 3700 + 1500 + 500
  assert.equal(u3.endMs, 6700); // 5700 + 1000
});

test("compileTimeline totalMs equals sum of all utterance durations and pauses", () => {
  const ep = testEpisode();
  const clips = testClips();
  const timeline = compileTimeline(ep, clips, 30);

  // 1000 + 400 + 2000 + 300 + 1500 + 500 + 1000 + 200 = 6900
  assert.equal(timeline.totalMs, 6900);
});

test("compileTimeline uses integer milliseconds (no float accumulation)", () => {
  const ep = testEpisode();
  const clips = testClips();
  const timeline = compileTimeline(ep, clips, 30);

  for (const shot of timeline.shots) {
    for (const u of shot.utterances) {
      assert.ok(Number.isInteger(u.startMs), `startMs should be integer: ${u.startMs}`);
      assert.ok(Number.isInteger(u.endMs), `endMs should be integer: ${u.endMs}`);
    }
    assert.ok(Number.isInteger(shot.durationMs), `durationMs should be integer: ${shot.durationMs}`);
  }
  assert.ok(Number.isInteger(timeline.totalMs));
});

test("compileTimeline throws on missing speech clip", () => {
  const ep = testEpisode();
  const clips = new Map<string, SpeechClip>(); // empty — all missing

  assert.throws(
    () => compileTimeline(ep, clips, 30),
    /Missing speech clip/,
  );
});

test("compileTimeline produces no overlapping utterances", () => {
  const ep = testEpisode();
  const clips = testClips();
  const timeline = compileTimeline(ep, clips, 30);

  for (const shot of timeline.shots) {
    for (let i = 1; i < shot.utterances.length; i++) {
      const prev = shot.utterances[i - 1]!;
      const curr = shot.utterances[i]!;
      assert.ok(
        curr.startMs >= prev.endMs,
        `utterance ${i} starts (${curr.startMs}) after previous ends (${prev.endMs})`,
      );
    }
  }
});
