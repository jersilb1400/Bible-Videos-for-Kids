# Bible Story Studio — v2 As-Built Architecture

**Last verified:** 2026-07-22

**Status:** Reproducible engineering prototype; not professional-production-ready

**Forward plan:** [`plans/2026-07-22-professional-cartoon-studio-plan.md`](./plans/2026-07-22-professional-cartoon-studio-plan.md)

**MLX audit:** [`plans/mlx-upgrade-plan.md`](./plans/mlx-upgrade-plan.md)

## Honest scope

The v2 branch provides a real, deterministic Node/TypeScript pipeline skeleton for validating episode manifests, generating fixture speech, rendering simple SVG-cutout shots, assembling an MP4, and writing sidecar captions. An Edge CLI adapter exists, but it was not runnable on the audited host and is not part of the reproduced proof.

It does **not** yet provide professional character animation, verified phoneme lip sync, real music scoring/ducking in the proof, a creator UI, or integrated MLX media providers. The fixture proof is structural and silent by design. The v2 pipeline is also not yet the single canonical route through the legacy CLI, dashboard, and Cloudflare surfaces.

## Current flow

```text
Episode JSON
  → Zod validation
  → speech provider (Fixture | Edge CLI)
  → integer-ms timeline
  → fallback mouth-cue analysis
  → SVG cutout frame rendering with Sharp
  → FFmpeg concat/audio mux
  → master MP4 + sidecar SRT
```

## Verified design properties

1. **Dialogue-first schema** — episodes contain shots and per-character dialogue lines.
2. **Deterministic fixture path** — seeded blink/timing behavior and fixture speech support repeatable structural tests.
3. **Stage workspaces** — the pipeline records stage state, hashes, and logs. Recovery behavior exists, but is not yet validated as a product-level persistent job queue.
4. **Provider boundaries** — speech and renderer abstractions exist, though their contracts need expansion for production media.
5. **Sidecar captions** — SRT is produced; the proof MP4 has no embedded subtitle stream.
6. **Local FFmpeg assembly** — the final artifact is generated without a cloud renderer.

## Important limitations

### Speech

- `FixtureSpeechProvider` produces silent structural clips. It is not evidence of real voices.
- Edge TTS depends on an external CLI that was missing on the audited host; its production voice quality and failure behavior are unverified.
- The current episode `voiceId` values are not proven to reach the Edge invocation, so cast-to-voice assignment is not yet verified end to end.
- No local Qwen3-TTS provider is implemented.
- No voice-consent/provenance model exists.

### Lip sync

- The current fallback in `src/lipsync/analyze.ts` estimates duration from file bytes as if compressed audio were raw PCM.
- MP3 byte size cannot provide valid phoneme or viseme timing.
- Rhubarb/provider files exist, but the canonical proof does not verify a real alignment path.
- A production alignment-provider contract and known-audio tests are required.

### Visual rendering

- Current rigs and backgrounds are geometric proof assets.
- The contact sheet shows basic flat backgrounds, one simple character style, repeated composition, and limited staging.
- The renderer does not yet implement the episode schema's pose/action/emotion intent as real acting controls, and the current asset-path logic does not prove that authored background plates are used correctly.
- No professional environment, pose, acting, camera, lighting, effects, or model-sheet approval workflow exists.
- Sharp rasterizes each SVG frame independently; the current proof renders slower than real time.

### Audio/music

- The proof has an AAC stream but is effectively silent.
- `ffmpeg` measured approximately `-91 dB` mean and maximum volume.
- No production music cue is present.
- No verified music generation, cue library, side-chain ducking, or final loudness gate exists.

### Product operation

- The repository is operated through scripts/CLI.
- The legacy CLI, v2 pipeline, dashboard/Cloudflare surface, and other experimental scripts are not yet one integrated product path.
- There is no local studio UI, persistent project database, job queue, review workflow, model preflight, or final delivery gate.

## File map

### Schema and orchestration

- `src/types.ts` — v2 episode/shot/dialogue schemas
- `src/legacy/v1Adapter.ts` — v1 story conversion
- `src/timeline.ts` — compiled integer-ms timeline
- `src/pipelineV2.ts` — stage orchestration

### Speech and alignment

- `src/providers/speech.ts` — fixture and Edge speech providers
- `src/providers/rhubarb.ts` — Rhubarb adapter support
- `src/providers/fallbackVisemes.ts` — deterministic fallback mapping
- `src/lipsync/analyze.ts` — current analysis wrapper; must be corrected before production
- `src/lipsync/types.ts` — mouth-cue track types and validation

### Rendering and assembly

- `src/assets.ts` — manifest/rig loading
- `src/renderers/types.ts` — renderer contract
- `src/renderers/svgCutout.ts` — current SVG/Sharp/H.264 renderer
- `src/stages/assemble2.ts` — FFmpeg assembly and SRT generation

### Proof inputs

- `episodes/proof-daniel-v2.json`
- `assets/manifest.v1.json`
- `scripts/render-proof.ts`

## Reproduced proof result

Command:

```bash
npm run proof:v2
```

The proof script (`scripts/render-proof.ts`) renders the proof episode through the v2 pipeline using `FixtureSpeechProvider` (silent structural WAVs). It probes the output MP4 with `ffprobe` and saves QC metadata as `out/proof-daniel-qc.json`.

### Honest labeling

The QC metadata labels this as `"structural — fixture audio (silent WAVs)"`. It is NOT evidence of real voices, production lip sync, or production visual quality. It validates pipeline mechanics: schema validation, timeline compilation, rendering, assembly, and caption generation.

### QC metadata fields

```json
{
  "proof": "v2",
  "label": "structural — fixture audio (silent WAVs)",
  "episode": { "title", "shots", "cast" },
  "timeline": { "totalFrames", "durationMs" },
  "probe": {
    "videoCodec", "audioCodec", "width", "height",
    "durationSec", "reportFrames", "actualFrames", "frameAgreement"
  },
  "captionsFile"
}
```

### Probed master (2026-07-25)

- H.264 video, 1280×720, 30 fps;
- 1,344 video frames (`ffprobe` actual);
- 1,347 frames (timeline report);
- frame agreement: `true` (within ±5 tolerance for H.264 GOP padding);
- AAC mono, 48 kHz;
- duration 44.82 seconds;
- SRT sidecar with 13 cues.

### Determinism

Two consecutive fixture renders on the same environment produce identical SHA-256 hashes. This is verified by `test/proof-contract.test.ts`.

### Proof contract test

`test/proof-contract.test.ts` verifies:
1. The output MP4 has both video and audio streams.
2. QC metadata exists with honest labeling (no "production" or "real voices" claims).
3. Reported and actual frame counts agree (±5 tolerance).
4. Two fixture renders produce identical hashes.

## Current verification state

```text
root npm run typecheck:      PASS
root npm test:               PASS (139 tests, 0 failures)
root npm run proof:v2:       PASS (exits 0, produces MP4 + QC JSON)
root npm run build:          N/A (no build script)
cloudflare npm run typecheck: PASS; no automated tests
dashboard npm run build:     FAIL (TS2688: missing `node 2` type definition); no automated tests
```

Configuration is now hermetic: `loadConfig(env)` + `setConfig(cfg)` isolate tests from `.env` and shell environment variables. The legacy full-pipeline test no longer leaks ambient API keys. FFmpeg filter availability (`drawtext`, `libass`) is detected at runtime with graceful degradation — missing filters produce a warning and ship sidecar SRT captions instead of burning them in.

## What “v2 complete” must now mean

The as-built skeleton becomes a production application only after it gains:

- honest green tests and artifact probes;
- real WAV normalization and phoneme/viseme alignment;
- professional reusable character/environment assets;
- multi-character blocking, camera, pose, and effects animation;
- approved local voices with consent records;
- music generation/library, ducking, and mastering;
- local MLX provider adapters and benchmark gates;
- persistent projects/jobs/provenance;
- a creator UI and review workflow;
- final delivery QC.

Use the dated professional studio plan as the implementation source of truth.
