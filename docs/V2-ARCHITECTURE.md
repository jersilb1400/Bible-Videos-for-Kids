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
./node_modules/.bin/tsx scripts/render-proof.ts
```

Two consecutive runs at repository HEAD `df689ef` on the audited machine produced identical hashes:

```text
31c451127f4b17fd4276240c8f89a42b88911475dcaa8ebbc2eb9ec78d23aa62  out/proof-daniel.mp4
affe4bad81f5ba873c579e7aaae1a9faf5ebeaf790358e1cd7abf20e6e62accc  out/proof-daniel.srt
```

These replace the hashes recorded before the post-documentation changes to `svgCutout.ts`, `assemble2.ts`, and timeline/types code. Determinism is established only for repeated runs of the same code, inputs, dependencies, and environment; it is not a stable golden hash across code revisions.

Probed master:

- H.264 video, 1280×720, 30 fps;
- 1,344 video frames;
- AAC mono, 48 kHz;
- duration 44.820 seconds;
- 303,579 bytes;
- SRT with 13 cues, final cue ending at 44.520 seconds.

The script reported 1,347 frames while `ffprobe` counted 1,344. The production plan includes correcting this metadata mismatch.

The two current-HEAD verification renders took 138.4 and 101.7 seconds, about 3.09× and 2.27× the final video duration. The large difference despite byte-identical outputs confirms that these are reproducibility checks, not controlled performance benchmarks.

## Current verification state

```text
root npm run typecheck:      PASS, with 17 source paths explicitly excluded
root npm test:               FAIL (61 total, 60 pass, 1 fail)
root npm run build:          FAIL (no build script)
cloudflare npm run typecheck: PASS; no automated tests
dashboard npm run build:     FAIL (TS2688: missing `node 2` type definition); no automated tests
```

The failing legacy full-pipeline test is not hermetic. In the latest root run it loaded ambient OpenRouter configuration and failed with HTTP 401 even though the test is named `offline (no keys)`. In an isolated specialist run it advanced farther and failed because the installed FFmpeg lacks `drawtext`; this FFmpeg build also lacks the `subtitles` filter, and Rhubarb is not installed. These are separate prerequisites hidden behind the same test. The first implementation milestone makes configuration and tool discovery explicit, then restores a genuinely green baseline.

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
