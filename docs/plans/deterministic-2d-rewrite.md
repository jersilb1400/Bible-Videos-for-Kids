# Deterministic 2D Cartoon Rewrite — Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Replace the narrated slideshow with a deterministic 2D cut-out animation pipeline producing talking-character cartoons with lip sync, distinct voices, proper music, and captions.

**Architecture:** Dialogue-first shot schema → per-utterance TTS → canonical lip-sync track (Rhubarb or deterministic fallback) → SVG cut-out renderer (mouth swapping, blinks, poses) → FFmpeg frame encoding → professional audio mix with ducking and loudness mastering → final H.264/AAC episode.

**Tech Stack:** TypeScript, Zod, Node.js, @resvg/resvg-js, FFmpeg/ffprobe, Rhubarb Lip Sync (optional), Edge-TTS/Kokoro/ElevenLabs (per-character voices).

---

## Phase 0: Baseline Stabilization ✅

- [x] Add `@types/node`, commit `package-lock.json`
- [x] Exclude experimental untracked files from `tsconfig.json`
- [x] Strengthen `.gitignore`
- [x] `npm run typecheck` passes
- [x] 3/4 tests pass (1 pre-existing FFmpeg drawtext issue on macOS)

---

## Phase 1: Dialogue-First Schema + Timeline

### Task 1.1: Episode/Shot/DialogueLine types with Zod validation

**Files:**
- Modify: `src/types.ts`
- Create: `src/legacy/v1Adapter.ts`
- Test: `test/schema.test.ts`

```ts
export type Emotion = "neutral" | "joy" | "sad" | "afraid" | "brave" | "wonder";
export type MouthShape = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "X";
export type CameraMove = "locked" | "push-in" | "pan-left" | "pan-right";

export const DialogueLineSchema = z.object({
  id: z.string().min(1),
  speakerId: z.string().min(1),
  text: z.string().min(1),
  emotion: z.enum(["neutral","joy","sad","afraid","brave","wonder"]).default("neutral"),
  pauseAfterMs: z.number().int().min(0).default(300),
});

export const ShotActorSchema = z.object({
  characterId: z.string().min(1),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  scale: z.number().positive().default(1),
  pose: z.string().default("neutral"),
  facing: z.enum(["left","right"]).default("right"),
});

export const ShotSchema = z.object({
  id: z.string().min(1),
  settingId: z.string().min(1),
  actors: z.array(ShotActorSchema).min(1),
  leadIn: z.object({ text: z.string(), pauseAfterMs: z.number().int().min(0) }).optional(),
  dialogue: z.array(DialogueLineSchema).min(1),
  action: z.string().default(""),
  camera: z.enum(["locked","push-in","pan-left","pan-right"]).default("locked"),
});

export const CharacterRigRefSchema = z.object({
  characterId: z.string().min(1),
  rigId: z.string().min(1),
  voiceId: z.string().min(1),
});

export const EpisodeSchema = z.object({
  schemaVersion: z.literal(2),
  title: z.string().min(1),
  source: z.string().min(1),
  lesson: z.string().min(1),
  cast: z.array(CharacterRigRefSchema).min(1),
  shots: z.array(ShotSchema).min(1),
}).superRefine((ep, ctx) => {
  // Shot/line IDs unique
  // Every dialogue speaker in cast
  // Every dialogue speaker in that shot's actors
  // Rig/voice IDs resolve
});
```

**V1 adapter:** `adaptV1Story(story: Story): Episode` — each scene → one shot, narration → leadIn, no fabricated dialogue.

### Task 1.2: Timeline compiler

**Files:**
- Create: `src/timeline.ts`
- Test: `test/timeline.test.ts`

Compiles episode shots into an authoritative timeline using real audio durations + pauses. Output:

```ts
export interface PlacedUtterance {
  utteranceId: string;
  shotId: string;
  speakerId: string;
  text: string;
  startMs: number;  // episode-relative
  endMs: number;
}
export interface ShotTimeline {
  shotId: string;
  startFrame: number;
  endFrame: number; // exclusive
  durationMs: number;
  utterances: PlacedUtterance[];
}
export interface EpisodeTimeline {
  totalFrames: number;
  totalMs: number;
  fps: number;
  shots: ShotTimeline[];
}
```

Rules: integer milliseconds, no float accumulation, frame count = ceil(durationMs * fps / 1000).

### Task 1.3: Per-utterance speech stage

**Files:**
- Create: `src/providers/speech.ts` (SpeechProvider interface + fixtures)
- Create: `src/stages/speech.ts` (orchestration)
- Modify: `src/config.ts` (add per-character voice config)
- Test: `test/speech.test.ts`

```ts
export interface SpeechRequest {
  utteranceId: string;
  speakerId: string;
  voiceId: string;
  text: string;
  emotion: Emotion;
  outputPath: string; // .wav
}
export interface SpeechClip {
  utteranceId: string;
  file: string;
  durationMs: number; // from ffprobe, not estimates
}
export interface SpeechProvider {
  readonly id: string;
  synthesize(req: SpeechRequest): Promise<SpeechClip>;
}
```

One file per utterance. Deterministic fixture provider for tests (generates silence WAVs of text-length-proportional duration). Real providers: Edge-TTS (free), Kokoro (local), ElevenLabs (premium).

---

## Phase 2: Lip Sync + 2D Renderer

### Task 2.1: Canonical lip-sync contract + Rhubarb adapter

**Files:**
- Create: `src/lipsync/types.ts` (LipSyncTrack, MouthCue)
- Create: `src/providers/rhubarb.ts` (discovery + invocation)
- Test: `test/visemes.test.ts`, `test/fixtures/rhubarb-output.json`

```ts
export interface MouthCue { startSec: number; endSec: number; shape: MouthShape; }
export interface LipSyncTrack {
  schemaVersion: 1;
  trackId: string;
  utteranceId: string;
  speakerId: string;
  audio: { path: string; sha256: string; durationSec: number; sampleRate: 48000; channels: 1 };
  analyzer: { kind: "rhubarb" | "energy-text-v1" | "rest"; ... };
  cues: MouthCue[];
}
```

Rhubarb discovery: RHUBARB_BIN → vendor/ → PATH. Mode: auto/required/disabled. Validate output, fallback on failure.

### Task 2.2: Deterministic energy-text-v1 fallback

**Files:**
- Create: `src/providers/fallbackVisemes.ts`
- Test: `test/visemes.test.ts` (same test file)

Algorithm: RMS energy in 20ms windows → dBFS → threshold → active regions → grapheme-to-viseme mapping from transcript → proportional distribution → X rest during silence. No randomness. Deep-comparable across runs.

### Task 2.3: Character rig manifest + asset resolver

**Files:**
- Create: `src/assets.ts`
- Create: `assets/manifest.v1.json`
- Create: `assets/characters/daniel/` (body.svg, mouths A-F+X, eyes open/closed, poses)
- Create: `assets/characters/darius/` (same set)
- Create: `assets/backgrounds/` (palace.svg, window-room.svg, lions-den.svg, sunrise.svg)
- Test: `test/assets.test.ts`

Rig manifest schema with required A-F mouths, optional G/H/X. Anchors for mouth, eyes, ground. Reject missing files, path traversal.

### Task 2.4: SVG cut-out renderer

**Files:**
- Create: `src/renderers/types.ts` (HeadlessRenderer interface)
- Create: `src/renderers/svgCutout.ts` (implementation)
- Create: `src/renderers/svgComposer.ts` (SVG layer composition)
- Create: `src/stages/render.ts` (shot rendering orchestration)
- Test: `test/svg-renderer.test.ts`

```ts
export interface HeadlessRenderer {
  readonly id: string;
  renderShot(req: RenderShotRequest): Promise<RenderedShot>;
}
```

Per frame: compose background → character bodies → mouths (viseme-selected) → eyes (blink schedule) → camera motion. Rasterize with @resvg/resvg-js → PNG → pipe to FFmpeg for silent H.264. Seed-based deterministic blinks and micro-motion.

### Task 2.5: Rhubarb adapter for lip sync stage

**Files:**
- Create: `src/stages/visemes.ts`
- Modify: `src/providers/rhubarb.ts` if needed
- Test: `test/visemes.test.ts` (adapter test with fake executable)

Normalize audio to 48kHz mono WAV → invoke rhubarb with dialogFile → parse/validate → canonical LipSyncTrack. Cache by WAV hash.

---

## Phase 3: Professional Audio + Captions + Assembly

### Task 3.1: Caption generation (SRT + ASS)

**Files:**
- Create: `src/stages/captions.ts`
- Test: `test/captions.test.ts`

Generate utterance-timed SRT and ASS from placed utterances. Two-line max, safe-area placement, bundled font (not system path). ASS for burn-in, SRT for sidecar.

### Task 3.2: Audio mix with ducking and loudness mastering

**Files:**
- Create: `src/stages/audio.ts`
- Modify: `src/providers/ffmpeg.ts` (add helpers)
- Test: `test/audio.test.ts`

Build dialogue bus → sidechaincompress music → mix → two-pass loudnorm (target -14 LUFS, true peak -1.5 dBTP) → single AAC encode at 48kHz stereo. No sine pad in shipping path.

### Task 3.3: Music + SFX provider

**Files:**
- Modify: `src/stages/music.ts`
- Create: `assets/audio/music/` (licensed gentle-hope.ogg + LICENSE.md)
- Test: `test/audio.test.ts` (integration)

Use licensed bundled music. Ducking during speech. Fades at episode boundaries.

### Task 3.4: Final assembly (v2 pipeline wiring)

**Files:**
- Modify: `src/pipeline.ts` (new stage order)
- Modify: `src/config.ts`
- Test: `test/proof-episode.test.ts`

New stage order: script → safety → assets → speech → timeline → visemes → render shots → captions → audio master → thumbnail → metadata → publish.

---

## Phase 4: Proof Episode

### Task 4.1: Daniel and the Lions' Den proof episode script

**Files:**
- Create: `episodes/proof-daniel-v2.json`

60-90 seconds. Two speaking characters (Daniel, King Darius). 5-7 shots. At least 70% dialogue. Emotion cues. Camera moves.

### Task 4.2: Proof episode rendering + verification

**Files:**
- Test: `test/proof-episode.test.ts`

Assert: duration 60-90s, ≥2 speaking characters, ≥70% dialogue, every utterance has audio+visemes+captions, final MP4 has video+audio, SRT/ASS/timeline/manifest exist, two runs produce identical semantic manifests.

---

## Phase 5: Adversarial Review + Documentation

### Task 5.1: Adversarial integration review

Dispatch adversarial reviewer to check: character consistency across shots, lip sync quality, audio loudness compliance, caption readability, determinism, no API keys required, renderer contract extensibility.

### Task 5.2: Documentation + commit

Update README.md, ARCHITECTURE.md, CLAUDE.md, PROGRESS.md. Final commit and push.

---

## Acceptance Criteria

1. `npm run typecheck` passes
2. `NO_API_KEYS=1 npm test` passes without network access
3. `npm run proof` creates a playable 1920×1080 H.264/AAC episode
4. Episode duration is 60–90 seconds
5. Daniel and Darius use distinct configured voices
6. Lip movements follow Rhubarb cues when available; deterministic fallback when not
7. Characters retain same rig, colors, anchors, and mouth set across shots
8. Captions are utterance-timed, readable, safe-area compliant, burned in + SRT sidecar
9. Licensed music replaces sine pad, ducks under speech, meets loudness/peak targets
10. Re-running with same script/assets/fixture speech/seed produces identical semantic manifests
11. No Blender/GPU/cloud/paid API required for tests
12. Renderer interface accepts a future Blender adapter without changing episode/speech/viseme/caption/audio contracts
