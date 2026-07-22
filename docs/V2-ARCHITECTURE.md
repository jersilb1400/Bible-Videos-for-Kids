# Bible Story Studio — Deterministic 2D Cartoon Pipeline (v2)

## Overview

A professional, offline-deterministic pipeline for producing 60–90 second Bible story
videos for children with **talking characters**, **lip-sync**, **per-character voices**,
**captions**, and **music ducking** — at near-zero cost.

## Architecture

```
Episode JSON
  → Zod validation (EpisodeSchema)
  → Per-utterance TTS (Fixture | Edge-TTS | Rhubarb)
  → Timeline compilation (integer ms, no float accumulation)
  → Lip-sync analysis (Rhubarb adapter | energy-text-v1 fallback)
  → SVG cut-out renderer (background + body + mouth visemes + blinks + camera)
  → Professional assembly (audio mix + side-chain ducking + SRT/ASS captions)
  → episode.mp4 + episode.srt
```

## Key Design Decisions

1. **Dialogue-first schema** — Episodes are organized around shots of talking characters, not narration-over-stills.
2. **Deterministic at every stage** — Mulberry32 PRNG for blinks, no `Math.random()`, no `Date.now()`, integer-ms timeline.
3. **Offline-capable** — FixtureSpeechProvider generates text-proportional silent WAVs for development without API keys.
4. **No drawtext dependency** — Uses ASS subtitles for burn-in (when libass available) or sidecar SRT (when not).
5. **Pluggable renderer** — `HeadlessRenderer` interface allows Blender headless adapter without rewriting the story/audio pipeline.

## File Map

### Schema & Types
- `src/types.ts` — v2 Episode/Shot/DialogueLine Zod schemas with superRefine
- `src/legacy/v1Adapter.ts` — Converts v1 narration-only Story → v2 Episode
- `src/lipsync/types.ts` — LipSyncTrack, MouthCue, validateLipSyncTrack
- `src/timeline.ts` — compileTimeline: EpisodeTimeline, ShotTimeline, PlacedUtterance

### Providers
- `src/providers/speech.ts` — SpeechProvider interface, FixtureSpeechProvider, EdgeTtsSpeechProvider
- `src/providers/rhubarb.ts` — Rhubarb binary discovery and invocation adapter
- `src/providers/fallbackVisemes.ts` — Deterministic energy-text-v1 viseme fallback

### Rendering
- `src/assets.ts` — RigManifest, loadManifest, resolveRig (path-traversal protected)
- `src/renderers/types.ts` — HeadlessRenderer interface
- `src/renderers/svgCutout.ts` — SvgCutoutRenderer: composes SVG frames, rasterizes with resvg, encodes H.264

### Stages
- `src/stages/speech.ts` — Orchestrate per-utterance TTS across all shots
- `src/stages/assemble2.ts` — Final assembly: concat → mix → duck → mux → captions
- `src/lipsync/analyze.ts` — Wraps Rhubarb + fallback into single analyzeUtterance

### Pipeline
- `src/pipelineV2.ts` — Full production pipeline: episode.json → validate → speech → timeline → render → assemble
- `scripts/render-proof.ts` — Render the proof episode

### Assets
- `assets/manifest.v1.json` — Rig manifest with characters, mouths, eyes, voices, anchors
- `assets/characters/daniel/` — Daniel SVG body, 7 mouth shapes, open/closed eyes
- `assets/characters/darius/` — King Darius SVG body, 7 mouth shapes, open/closed eyes
- `assets/backgrounds/` — Palace, window-room, lions' den, sunrise

### Tests
- `test/schema.test.ts` — 10 tests: Zod validation, v1 adapter, rejection cases
- `test/speech.test.ts` — 2 tests: FixtureSpeechProvider duration and determinism
- `test/timeline.test.ts` — 5 tests: Timeline compilation, integer ms, overlap detection
- `test/assets.test.ts` — 8 tests: Manifest loading, rig resolution, path traversal
- `test/visemes.test.ts` — 26 tests: Validator, Rhubarb parsing, fallback, grapheme mapping
- `test/svg-renderer.test.ts` — 4 tests: Viseme selection, blinks, MP4 output, repeatability
- `test/assembly.test.ts` — 2 tests: Assembly + ASS subtitles

### Episode Scripts
- `episodes/proof-daniel-v2.json` — "Daniel and the Lions' Den" (6 shots, 2 characters)

## Usage

```bash
# Render the proof episode (offline, no API keys needed)
npx tsx scripts/render-proof.ts

# Run all tests
npx tsx --test test/schema.test.ts test/speech.test.ts test/timeline.test.ts \
  test/assets.test.ts test/assembly.test.ts test/svg-renderer.test.ts \
  test/visemes.test.ts

# Typecheck
npm run typecheck
```

## Proof Episode

- **Title:** Daniel and the Lions' Den
- **Source:** Daniel 6
- **Duration:** 44.8 seconds
- **Shots:** 6 (Daniel praying → Darius's decree → Daniel arrested → Lions' den → Daniel safe → Sunrise)
- **Cast:** Daniel (en-US-ChristopherNeural), King Darius (en-US-DavisNeural)
- **Output:** `out/proof-daniel.mp4` (1280×720, H.264, AAC, 532KB)
- **Captions:** `out/proof-daniel.srt` (13 cues)

## Test Results

```
# tests 57
# pass 57
# fail 0
```

Zero typecheck errors across the entire codebase.
