import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  EMOTION_MODULATION,
  generateBreathSchedule,
  breathScaleAt,
  generateGestures,
  headOffsetAt,
  buildPerformanceTrack,
  type GestureType,
} from "../src/performance/engine.js";
import { FixtureEnhancedProvider, createEnhancedSpeechProvider } from "../src/performance/voice.js";

// ────────────────────────────────────────────────────────────────────────────
// Emotion modulation
// ────────────────────────────────────────────────────────────────────────────

describe("EMOTION_MODULATION", () => {
  test("all 6 emotions have modulation parameters", () => {
    const emotions = ["neutral", "joy", "sad", "afraid", "brave", "wonder"] as const;
    for (const e of emotions) {
      assert.ok(EMOTION_MODULATION[e], `missing modulation for ${e}`);
      assert.ok(typeof EMOTION_MODULATION[e].rate === "number");
      assert.ok(typeof EMOTION_MODULATION[e].pitchHz === "number");
      assert.ok(typeof EMOTION_MODULATION[e].gainDb === "number");
    }
  });

  test("joy increases rate, sad decreases rate", () => {
    assert.ok(EMOTION_MODULATION.joy.rate > 1.0, "joy should be faster");
    assert.ok(EMOTION_MODULATION.sad.rate < 1.0, "sad should be slower");
  });

  test("brave increases gain, afraid decreases gain", () => {
    assert.ok(EMOTION_MODULATION.brave.gainDb > 0, "brave should be louder");
    assert.ok(EMOTION_MODULATION.afraid.gainDb < 0, "afraid should be quieter");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Breathing schedule
// ────────────────────────────────────────────────────────────────────────────

describe("generateBreathSchedule", () => {
  test("is deterministic — same seed produces same schedule", () => {
    const a = generateBreathSchedule(42, 30);
    const b = generateBreathSchedule(42, 30);
    assert.deepEqual(a, b);
  });

  test("different seeds produce different schedules", () => {
    const a = generateBreathSchedule(42, 30);
    const b = generateBreathSchedule(99, 30);
    assert.notDeepEqual(a, b);
  });

  test("cycles span the duration", () => {
    const cycles = generateBreathSchedule(42, 30);
    assert.ok(cycles.length > 0, "should have at least one cycle");
    const last = cycles[cycles.length - 1]!;
    assert.ok(last.startSec < 30, "last cycle should start before duration end");
  });

  test("inhale and exhale have positive durations", () => {
    const cycles = generateBreathSchedule(42, 30);
    for (const c of cycles) {
      assert.ok(c.inhaleSec > 0, "inhale must be positive");
      assert.ok(c.exhaleSec > 0, "exhale must be positive");
    }
  });
});

describe("breathScaleAt", () => {
  test("returns 1.0 outside any cycle", () => {
    const cycles = generateBreathSchedule(42, 30);
    // Before first breath starts
    const scale = breathScaleAt(cycles, 0.01);
    assert.ok(scale >= 0.999 && scale <= 1.001, `expected ~1.0, got ${scale}`);
  });

  test("returns >1.0 during inhale", () => {
    const cycles = generateBreathSchedule(42, 30);
    if (cycles.length > 0) {
      const midInhale = cycles[0]!.startSec + cycles[0]!.inhaleSec * 0.5;
      const scale = breathScaleAt(cycles, midInhale);
      assert.ok(scale > 1.0, `expected >1.0 during inhale, got ${scale}`);
      assert.ok(scale <= 1.013, `scale should not exceed 1.012+epsilon, got ${scale}`);
    }
  });

  test("never exceeds ~1.012 max depth", () => {
    const cycles = generateBreathSchedule(42, 60);
    let maxScale = 1.0;
    for (let t = 0; t < 60; t += 0.1) {
      maxScale = Math.max(maxScale, breathScaleAt(cycles, t));
    }
    assert.ok(maxScale <= 1.013, `max scale ${maxScale} exceeds 1.012+epsilon`);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Gesture generation
// ────────────────────────────────────────────────────────────────────────────

describe("generateGestures", () => {
  const mockUterances = [
    { utteranceId: "l1", speakerId: "daniel", text: "Hello, good morning!", startSec: 0, durationSec: 2 },
    { utteranceId: "l2", speakerId: "daniel", text: "Look over there!", startSec: 2.5, durationSec: 1.5 },
    { utteranceId: "l3", speakerId: "darius", text: "No, that is not right.", startSec: 4, durationSec: 1.8 },
    { utteranceId: "l4", speakerId: "daniel", text: "Praise God for this day.", startSec: 6, durationSec: 2.5 },
    { utteranceId: "l5", speakerId: "darius", text: "Indeed, truly Amen.", startSec: 8.5, durationSec: 1.5 },
    { utteranceId: "l6", speakerId: "daniel", text: "I must decree this law.", startSec: 10, durationSec: 2 },
  ];

  test("classifies text into correct gesture types", () => {
    const gestures = generateGestures(mockUterances);
    const map = new Map(gestures.map(g => [g.triggerUtteranceId, g.type]));

    assert.equal(map.get("l1"), "wave", "'Hello, good morning!' → wave");
    assert.equal(map.get("l2"), "point", "'Look over there!' → point");
    assert.equal(map.get("l3"), "head-shake", "'No, that is not right.' → head-shake");
    assert.equal(map.get("l4"), "raise-hands", "'Praise God' → raise-hands");
    assert.equal(map.get("l5"), "nod", "'Indeed, truly Amen' → nod");
    assert.equal(map.get("l6"), "fold-arms", "'decree this law' → fold-arms");
  });

  test("gesture duration is capped at 1.5s", () => {
    const gestures = generateGestures(mockUterances);
    for (const g of gestures) {
      assert.ok(g.durationSec <= 1.5, `duration ${g.durationSec} exceeds 1.5s`);
    }
  });

  test("no gesture for neutral text", () => {
    const gestures = generateGestures([
      { utteranceId: "neutral", speakerId: "x", text: "The cat sat on the mat.", startSec: 0, durationSec: 2 },
    ]);
    assert.equal(gestures.length, 0, "neutral text should produce no gesture");
  });

  test("gestures are attributed to correct speaker", () => {
    const gestures = generateGestures(mockUterances);
    for (const g of gestures) {
      assert.equal(g.characterId, mockUterances.find(u => u.utteranceId === g.triggerUtteranceId)!.speakerId);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Head movement
// ────────────────────────────────────────────────────────────────────────────

describe("headOffsetAt", () => {
  test("neutral emotion has small sway", () => {
    const offset = headOffsetAt(5, "neutral", 42, false);
    assert.ok(Math.abs(offset.xFrac) < 0.01, "neutral xFrac should be small");
    assert.ok(Math.abs(offset.yFrac) < 0.01, "neutral yFrac should be small");
    assert.ok(Math.abs(offset.rotateDeg) < 1.0, "neutral rotate should be small");
  });

  test("sad emotion has downward y bias", () => {
    const neutral = headOffsetAt(5, "neutral", 42, false);
    const sad = headOffsetAt(5, "sad", 42, false);
    assert.ok(sad.yFrac > neutral.yFrac, "sad should have head lower (higher yFrac)");
  });

  test("wonder emotion has upward y bias", () => {
    const neutral = headOffsetAt(5, "neutral", 42, false);
    const wonder = headOffsetAt(5, "wonder", 42, false);
    assert.ok(wonder.yFrac < neutral.yFrac, "wonder should have head higher (lower yFrac)");
  });

  test("deterministic — same inputs produce same output", () => {
    const a = headOffsetAt(3.7, "joy", 42, true);
    const b = headOffsetAt(3.7, "joy", 42, true);
    assert.deepEqual(a, b);
  });

  test("afraid has tremor (non-zero rotate)", () => {
    const offset = headOffsetAt(2.5, "afraid", 42, false);
    assert.ok(Math.abs(offset.rotateDeg) > 0, "afraid should have tremor");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Performance track
// ────────────────────────────────────────────────────────────────────────────

describe("buildPerformanceTrack", () => {
  test("builds a complete track for a speaking character", () => {
    const track = buildPerformanceTrack(
      "daniel",
      42,
      30,
      "joy",
      [
        { utteranceId: "l1", speakerId: "daniel", text: "Hello there!", startSec: 0, durationSec: 2 },
        { utteranceId: "l2", speakerId: "darius", text: "Goodbye.", startSec: 2.5, durationSec: 1.5 },
      ],
    );
    assert.equal(track.characterId, "daniel");
    assert.equal(track.emotion, "joy");
    assert.ok(track.breathing.length > 0, "should have breathing cycles");
    assert.equal(track.gestures.length, 1, "only daniel's gesture (wave for hello)");
    assert.equal(track.gestures[0]!.type, "wave");
  });

  test("different character seeds produce different breathing", () => {
    const daniel = buildPerformanceTrack("daniel", 42, 30, "neutral", []);
    const darius = buildPerformanceTrack("darius", 42, 30, "neutral", []);
    assert.notDeepEqual(daniel.breathing, darius.breathing);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Enhanced speech (fixture provider)
// ────────────────────────────────────────────────────────────────────────────

describe("FixtureEnhancedProvider", () => {
  const provider = new FixtureEnhancedProvider();

  test("synthesizes a clip with correct metadata", async () => {
    const clip = await provider.synthesize({
      utteranceId: "test-1",
      speakerId: "daniel",
      text: "Hello world",
      emotion: "joy",
      voiceProfile: {
        providerVoiceId: "en-US-ChristopherNeural",
        rate: 1.0,
        pitch: 0,
      },
      outputPath: "/tmp/test-perf-1.wav",
    });
    assert.equal(clip.utteranceId, "test-1");
    assert.equal(clip.emotion, "joy");
    assert.ok(clip.durationMs > 0, "duration should be positive");
    assert.equal(clip.file, "/tmp/test-perf-1.wav");
  });

  test("duration is proportional to text length", async () => {
    const short = await provider.synthesize({
      utteranceId: "short",
      speakerId: "x",
      text: "Hi",
      emotion: "neutral",
      voiceProfile: { providerVoiceId: "v", rate: 1, pitch: 0 },
      outputPath: "/tmp/test-perf-short.wv",
    });
    const long = await provider.synthesize({
      utteranceId: "long",
      speakerId: "x",
      text: "This is a much longer sentence that should take more time to say",
      emotion: "neutral",
      voiceProfile: { providerVoiceId: "v", rate: 1, pitch: 0 },
      outputPath: "/tmp/test-perf-long.wv",
    });
    assert.ok(long.durationMs > short.durationMs, "longer text should have longer duration");
  });

  test("factory creates correct provider type", () => {
    assert.equal(createEnhancedSpeechProvider("fixture").id, "fixture-enhanced");
    assert.equal(createEnhancedSpeechProvider("edge-tts").id, "edge-tts-enhanced");
    assert.equal(createEnhancedSpeechProvider("local").id, "fixture-enhanced");
  });
});
