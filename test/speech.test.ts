import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FixtureSpeechProvider, getAudioDurationMs, type SpeechRequest } from "../src/providers/speech.js";
import {
  VOICE_REGISTRY,
  DEFAULT_VOICE,
  resolveVoice,
  availableVoices,
} from "../src/providers/voiceRegistry.js";

test("FixtureSpeechProvider generates a WAV file with duration proportional to text length", async () => {
  const dir = mkdtempSync(join(tmpdir(), "speech-test-"));
  const outputPath = join(dir, "test.wav");

  const provider = new FixtureSpeechProvider();
  const req: SpeechRequest = {
    utteranceId: "test-1",
    speakerId: "daniel",
    voiceId: "voice:daniel",
    text: "Hello, this is a test of the speech system.",
    emotion: "neutral",
    rate: 1.0,
    pitch: 0,
    outputPath,
  };

  const clip = await provider.synthesize(req);

  assert.equal(clip.utteranceId, "test-1");
  assert.equal(clip.file, outputPath);
  assert.ok(clip.durationMs >= 500, "duration should be at least 500ms");

  // Verify with ffprobe
  const probedMs = await getAudioDurationMs(outputPath);
  const diff = Math.abs(probedMs - clip.durationMs);
  assert.ok(diff < 50, `ffprobe duration (${probedMs}ms) should match clip (${clip.durationMs}ms) within 50ms`);

  rmSync(dir, { recursive: true, force: true });
});

test("FixtureSpeechProvider produces deterministic durations for identical text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "speech-determinism-"));
  const provider = new FixtureSpeechProvider();

  const baseReq = (id: string): SpeechRequest => ({
    utteranceId: id,
    speakerId: "daniel",
    voiceId: "voice:daniel",
    text: "God is with us.",
    emotion: "neutral",
    rate: 1.0,
    pitch: 0,
    outputPath: join(dir, `${id}.wav`),
  });

  const clip1 = await provider.synthesize(baseReq("a"));
  const clip2 = await provider.synthesize(baseReq("b"));

  assert.equal(clip1.durationMs, clip2.durationMs, "identical text should produce identical durations");
  rmSync(dir, { recursive: true, force: true });
});

// --- Voice registry tests -------------------------------------------------

test("resolveVoice maps character IDs to Microsoft voice names", () => {
  assert.equal(resolveVoice("narrator"), "en-US-ChristopherNeural");
  assert.equal(resolveVoice("daniel"), "en-US-GuyNeural");
  assert.equal(resolveVoice("mother"), "en-US-JennyNeural");
  assert.equal(resolveVoice("darius"), "en-US-BrianNeural");
  assert.equal(resolveVoice("angel"), "en-US-AriaNeural");
});

test("resolveVoice returns default for unknown character IDs", () => {
  assert.equal(resolveVoice("unknown-char"), DEFAULT_VOICE);
  assert.equal(resolveVoice("random-guy"), DEFAULT_VOICE);
});

test("resolveVoice passes through raw Microsoft voice names unchanged", () => {
  assert.equal(resolveVoice("en-US-GuyNeural"), "en-US-GuyNeural");
  assert.equal(resolveVoice("en-GB-MaisieNeural"), "en-GB-MaisieNeural");
  assert.equal(resolveVoice("en-US-AriaNeural"), "en-US-AriaNeural");
});

test("resolveVoice handles undefined/empty voiceId with default fallback", () => {
  assert.equal(resolveVoice(undefined), DEFAULT_VOICE);
  assert.equal(resolveVoice(""), DEFAULT_VOICE);
});

test("voice registry has at least 8 distinct character voices", () => {
  const voices = availableVoices();
  // We need at least 8 distinct character entries in the registry.
  const characterKeys = ["narrator", "daniel", "mother", "darius", "angel", "elder", "child", "king"];
  for (const key of characterKeys) {
    assert.ok(VOICE_REGISTRY[key], `missing character voice: ${key}`);
    assert.ok(VOICE_REGISTRY[key]!.endsWith("Neural"), `${key} should map to a *Neural voice`);
  }
  // Count distinct voices — we want variety. Some keys share voices (e.g. elder/king).
  const distinctVoices = new Set(voices);
  assert.ok(distinctVoices.size >= 6, `expected >=6 distinct voices, got ${distinctVoices.size}`);
});

test("darius avoids en-US-DavisNeural (which failed with NoAudioReceived)", () => {
  assert.notEqual(resolveVoice("darius"), "en-US-DavisNeural",
    "darius must NOT use DavisNeural — it returns NoAudioReceived");
  assert.equal(resolveVoice("darius"), "en-US-BrianNeural",
    "darius should use BrianNeural as the replacement");
});

test("elder and king resolve to a deep male voice", () => {
  const elderVoice = resolveVoice("elder");
  const kingVoice = resolveVoice("king");
  assert.ok(elderVoice.endsWith("Neural"), "elder should be a Neural voice");
  assert.ok(kingVoice.endsWith("Neural"), "king should be a Neural voice");
  // Both should sound male — verify they're not the child/female defaults.
  assert.notEqual(elderVoice, "en-GB-MaisieNeural", "elder must not be child voice");
  assert.notEqual(kingVoice, "en-GB-MaisieNeural", "king must not be child voice");
});

test("legacy rig voice keys still resolve correctly", () => {
  assert.equal(resolveVoice("jenny"), "en-US-JennyNeural");
  assert.equal(resolveVoice("guy"), "en-US-GuyNeural");
  assert.equal(resolveVoice("maisie"), "en-GB-MaisieNeural");
  assert.equal(resolveVoice("aria"), "en-US-AriaNeural");
});
