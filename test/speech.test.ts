import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FixtureSpeechProvider, getAudioDurationMs, type SpeechRequest } from "../src/providers/speech.js";

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
