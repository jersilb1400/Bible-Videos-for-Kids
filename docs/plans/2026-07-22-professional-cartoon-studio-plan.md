# Professional Cartoon Studio — Implementation Plan

**Date:** 2026-07-22

**Project:** Bible Videos for Kids

**Depends on:** [`mlx-upgrade-plan.md`](./mlx-upgrade-plan.md)

**Target:** A local-first, low-marginal-cost, professional children’s cartoon creation application for reusable Bible-story episodes

**Planning status:** Implementation plan ready; current product is **NO-GO** for professional production, and all MLX media integrations remain benchmark-gated

## Product definition

Build a local **AI-assisted animation studio** in which a creator can:

1. create a series and episode;
2. enter or generate a source-grounded script;
3. lock reusable characters, voices, environments, and music themes;
4. edit a shot-level storyboard;
5. choose deterministic or generative rendering per shot;
6. generate dialogue with approved voices;
7. align speech to real visemes;
8. render, review, revise, and resume failed jobs;
9. export a verified master with captions and provenance;
10. reproduce the exact episode from a pinned manifest.

The application is not complete when an API returns a video. It is complete when a non-developer can create, revise, rerender, and export an episode without editing source code.

## Non-negotiable constraints

- Reusable character identity across episodes.
- Editable dialogue, timing, poses, camera, music, and captions.
- Local/private operation by default.
- All large models and render caches on `/Volumes/Misc` where practical.
- Model and output provenance recorded.
- Explicit voice-cloning consent records.
- Human editorial/theological review gates.
- No claim of “professional,” “lip-synced,” “licensed,” or “zero cost” based only on a successful request.
- Provider failure must be explicit; no silent fallback from conditioned to unconditioned output.
- Deterministic fixture mode remains available for tests.

## Target architecture

```text
React/Vite Studio UI
        │
        ▼
Local Node Control API ───── SQLite project/job database
        │                              │
        ▼                              ▼
Episode Orchestrator ───── Content-addressed asset store
        │
        ├── Script/source adapters
        ├── Speech providers
        │     ├── MLX Qwen3-TTS
        │     ├── Edge fallback
        │     └── Fixture
        ├── Alignment provider
        │     └── Rhubarb/forced-alignment baseline
        ├── Music providers
        │     ├── MLX ACE-Step
        │     └── Approved library
        ├── Image providers
        │     └── MLX FLUX (supervised asset work)
        ├── Shot renderers
        │     ├── Professional deterministic 2D
        │     └── Experimental MLX LTX-2.3
        └── FFmpeg assembly/QC/publish
```

### Proposed package boundaries

```text
src/
  domain/
    project.ts
    character.ts
    episode.ts
    shot.ts
    asset.ts
    provenance.ts
    review.ts
  application/
    projectService.ts
    episodeService.ts
    renderService.ts
    reviewService.ts
  jobs/
    queue.ts
    worker.ts
    events.ts
    recovery.ts
  providers/
    capabilities.ts
    mlxCoreClient.ts
    speech/
      types.ts
      fixture.ts
      edge.ts
      mlxQwenTts.ts
    music/
      types.ts
      approvedLibrary.ts
      mlxAceStep.ts
    image/
      types.ts
      mlxFlux.ts
    video/
      types.ts
      deterministic.ts
      mlxLtx.ts
  alignment/
    types.ts
    rhubarb.ts
    qa.ts
  render2d/
    rig.ts
    modelSheet.ts
    pose.ts
    camera.ts
    compositing.ts
    effects.ts
    renderer.ts
  quality/
    artifactProbe.ts
    audioQc.ts
    videoQc.ts
    identityRubric.ts
    deliveryGate.ts
  persistence/
    database.ts
    migrations/
    assetStore.ts
  server/
    app.ts
    routes/
  ui/
    ...
```

Do not perform a big-bang move. Preserve the current pipeline while these boundaries are introduced behind tests.

---

## Milestone 0 — Make the baseline honest and green

**Goal:** No future feature work builds on false proof claims or nondeterministic tests.

### Task 0.1 — Make configuration hermetic

**Files:**

- Modify `src/config.ts`
- Modify `src/pipelineV2.ts`
- Modify `test/pipeline.test.ts`
- Add `test/config.test.ts`

**Work:**

1. Replace module-import-time environment capture with `loadConfig(env, options)`.
2. Make `.env` loading an explicit entrypoint concern, not library behavior.
3. Pass `PipelineConfig` into `runPipelineV2` and provider factories.
4. Ensure tests can supply an isolated environment object.
5. Remove any stale default that selects a network/CLI provider during fixture tests.

**Acceptance:**

```bash
npm run typecheck
npm test
```

All 61 existing tests and new config tests pass even when the developer’s `.env` contains provider variables.

### Task 0.2 — Correct the proof contract

**Files:**

- Modify `scripts/render-proof.ts`
- Modify `package.json`
- Add `test/proof-contract.test.ts`
- Update `docs/V2-ARCHITECTURE.md`

**Work:**

1. Add a canonical `proof:v2` package script.
2. Label fixture audio as silent structural audio in logs and metadata.
3. Stop calling the proof “real voices” or “production lip sync.”
4. Probe the produced MP4 and save machine-readable QC metadata.
5. Derive reported frame count from the final stream, not per-shot estimates.
6. Assert SRT final time matches the master within the chosen tolerance.

**Acceptance:**

- The proof command exits nonzero if the MP4 lacks video/audio streams.
- Reported and probed frame counts agree.
- Two fixture renders have identical hashes on the same pinned environment.

### Task 0.3 — Replace fake compressed-byte lip sync

**Files:**

- Replace `src/lipsync/analyze.ts`
- Add `src/alignment/types.ts`
- Add `src/alignment/rhubarb.ts`
- Add `src/alignment/fixture.ts`
- Add `src/alignment/qa.ts`
- Add `test/alignment.test.ts`

**Work:**

1. Normalize speech clips to mono WAV before alignment.
2. Introduce `AlignmentProvider` returning timed phonemes/visemes.
3. Add Rhubarb as the first real alignment implementation.
4. Keep deterministic cue fixtures for tests.
5. Store the alignment JSON as an episode artifact.
6. Reject cue tracks outside audio duration.
7. Ensure only the speaking character receives mouth cues.

**Acceptance:**

- A known WAV fixture produces expected cue boundaries.
- MP3 byte length is never interpreted as PCM duration.
- Off-speaker characters remain in a closed/rest mouth state.

### Task 0.4 — Decide and enforce caption delivery

**Files:**

- Modify `src/stages/assemble2.ts`
- Add `src/quality/captionQc.ts`
- Add `test/captions.test.ts`

**Work:**

Support two explicit outputs:

1. master MP4 plus sidecar SRT; and
2. optional burned-in accessibility render.

Do not imply an embedded subtitle stream unless one exists. Validate cue order, duration, line length, safe margins, and output presence.

### Task 0.5 — Establish artifact probes

**Files:**

- Add `src/quality/artifactProbe.ts`
- Add `src/quality/audioQc.ts`
- Add `src/quality/videoQc.ts`
- Add `test/artifact-probe.test.ts`

**Work:**

Wrap `ffprobe`/`ffmpeg` to return typed evidence for:

- duration;
- streams/codecs;
- dimensions/fps/frame count;
- sample rate/channels;
- loudness/clipping;
- black/silent segments;
- caption boundary;
- file hash.

**Milestone gate:** tests green, proof metadata honest, no production claim relies on fixture behavior.

---

## Milestone 1 — Domain model, provenance, and resumable job engine

**Goal:** Turn a script pipeline into a creator application core.

### Task 1.1 — Add durable project schema

**Files:**

- Add `src/domain/project.ts`
- Add `src/domain/character.ts`
- Add `src/domain/episode.ts`
- Add `src/domain/shot.ts`
- Add `src/domain/asset.ts`
- Add `src/domain/provenance.ts`
- Add `src/domain/review.ts`
- Add `test/domain-schema.test.ts`

**Core entities:**

- `SeriesProject`
- `Episode`
- `Scene`
- `Shot`
- `CharacterBible`
- `CharacterRig`
- `VoiceProfile`
- `EnvironmentPack`
- `MusicCue`
- `GeneratedAsset`
- `ProviderInvocation`
- `ReviewDecision`
- `DeliveryArtifact`

Every generated asset records inputs, hashes, provider, model/revision, seed, preset, elapsed time, license reference, reviewer decision, and parent asset.

### Task 1.2 — Add SQLite persistence

**Files:**

- Add `src/persistence/database.ts`
- Add `src/persistence/migrations/001-initial.sql`
- Add `src/persistence/projectRepository.ts`
- Add `test/persistence.test.ts`

Use SQLite for metadata; keep large binaries in a content-addressed asset store.

### Task 1.3 — Add content-addressed asset storage

**Files:**

- Add `src/persistence/assetStore.ts`
- Add `src/persistence/paths.ts`
- Add `test/asset-store.test.ts`

Default paths:

- database/config under the project directory;
- large models under `/Volumes/Misc/huggingface_cache`;
- render cache under `/Volumes/Misc/Bible-Videos-for-Kids/cache`;
- approved local project assets remain in the repository/project library as appropriate.

Never assume `/Volumes/Misc` is mounted; preflight and offer an explicit fallback.

### Task 1.4 — Add a persistent job queue

**Files:**

- Add `src/jobs/queue.ts`
- Add `src/jobs/worker.ts`
- Add `src/jobs/events.ts`
- Add `src/jobs/recovery.ts`
- Add `test/jobs.test.ts`

Requirements:

- progress events;
- cancellation;
- retry policy;
- idempotency key;
- crash recovery;
- dependency graph;
- artifact-level resume;
- no duplicate provider charge/work after successful completion.

**Milestone gate:** create a project, persist an episode, enqueue a fixture render, restart the process, resume, and retrieve the final artifact.

---

## Milestone 2 — Professional deterministic 2D system

**Goal:** Make deterministic 2D a real production renderer rather than a geometric proof.

### Task 2.1 — Define a production character bible

**Files:**

- Add `src/render2d/modelSheet.ts`
- Add `src/render2d/rig.ts`
- Add `schemas/character-bible.schema.json`
- Add `test/model-sheet.test.ts`
- Add `assets/characters/README.md`

A locked character must include:

- canonical front/three-quarter/profile turnarounds;
- palette tokens;
- scale/age/style notes;
- eye/blink states;
- brow/emotion states;
- a real viseme mouth set;
- hand/arm poses;
- body poses;
- clothing and prop rules;
- forbidden drift examples;
- licensing/provenance.

### Task 2.2 — Replace monolithic SVG generation with layered rigs

**Files:**

- Add `src/render2d/pose.ts`
- Add `src/render2d/layers.ts`
- Add `src/render2d/compositing.ts`
- Refactor `src/renderers/svgCutout.ts`
- Add `test/rig-render.test.ts`

Cache static layers. Animate transforms and reusable mouth/eye/pose assets instead of rebuilding all geometry from scratch every frame.

### Task 2.3 — Add shot animation primitives

**Files:**

- Add `src/render2d/camera.ts`
- Add `src/render2d/keyframes.ts`
- Add `src/render2d/effects.ts`
- Add `src/render2d/blocking.ts`
- Add `test/shot-animation.test.ts`

Support:

- camera pan/tilt/zoom and ease curves;
- staging for multiple characters;
- pose transitions;
- eye focus and blinks;
- visemes;
- parallax backgrounds;
- particles/weather;
- foreground occlusion;
- reusable transitions;
- title/scripture cards.

### Task 2.4 — Build approved environment and prop libraries

**Files:**

- Add `assets/environments/README.md`
- Add `assets/props/README.md`
- Add `src/render2d/environment.ts`
- Add `test/environment.test.ts`

Start with the environments needed by the first reference episode. Do not attempt the entire Bible-world asset library before one episode passes quality review.

### Task 2.5 — Optimize the compositor

**Files:**

- Add `bench/render2d.ts`
- Modify `src/stages/assemble2.ts`
- Add `docs/benchmarks/render2d.md`

Compare the current Sharp-per-frame path with cached-layer rendering and streaming frames directly to FFmpeg. Pin a benchmark scene and report exact hardware, commit, dimensions, fps, wall time, and peak memory.

**Milestone gate:** a one-minute reference scene with two characters, real voices, correct visemes, camera moves, environment art, music, captions, and no placeholder geometry passes human review.

---

## Milestone 3 — Local voices and approved character voice library

**Goal:** Produce consistent, consented, audible character dialogue locally.

### Task 3.1 — Add a strict MLX Core client

**Files:**

- Add `src/providers/mlxCoreClient.ts`
- Add `src/providers/capabilities.ts`
- Add `test/mlx-core-client.test.ts`

Client preflight:

- health;
- installed model IDs;
- required capability;
- timeout/cancellation;
- response-size limits;
- actionable error mapping;
- no implicit download during a render.

### Task 3.2 — Implement Qwen3-TTS provider

**Files:**

- Split `src/providers/speech.ts` into `src/providers/speech/`
- Add `src/providers/speech/mlxQwenTts.ts`
- Add `src/providers/speech/types.ts`
- Add `test/mlx-qwen-tts.test.ts`

Provider contract:

```ts
interface SpeechRequest {
  text: string;
  characterId: string;
  referenceWav?: string;
  language?: string;
  seed?: number;
}

interface SpeechResult {
  wavPath: string;
  durationSeconds: number;
  sampleRate: number;
  providerInvocationId: string;
}
```

If a voice profile requires cloning, invalid or missing reference audio is a hard error. Normalize outputs to WAV before alignment and assembly.

### Task 3.3 — Add voice consent/provenance

**Files:**

- Add `src/domain/voiceConsent.ts`
- Add `schemas/voice-consent.schema.json`
- Add `test/voice-consent.test.ts`

Track consent owner, permitted characters/projects, recording date, source hashes, restrictions, and revocation status. The render job must refuse unapproved profiles.

### Task 3.4 — Run the TTS benchmark

**Files:**

- Add `bench/tts.ts`
- Add `fixtures/tts/benchmark-lines.json`
- Create `docs/benchmarks/qwen3-tts-m4-pro.md`

Compare 0.6B and 1.7B 8-bit. Promote only after blind listening, pronunciation, consistency, alignment, speed, and memory review.

**Milestone gate:** three approved character profiles produce repeatable, audible, intelligible dialogue and valid viseme tracks; all source audio and consent records are stored.

---

## Milestone 4 — Local music and final mix

**Goal:** Add proper, reusable music without burying dialogue.

### Task 4.1 — Add music provider boundary

**Files:**

- Add `src/providers/music/types.ts`
- Add `src/providers/music/approvedLibrary.ts`
- Add `src/providers/music/mlxAceStep.ts`
- Add `test/music-provider.test.ts`

### Task 4.2 — Build the approved cue library workflow

**Files:**

- Add `src/domain/musicCue.ts`
- Add `src/application/musicLibraryService.ts`
- Add `schemas/music-cue.schema.json`
- Add `test/music-library.test.ts`

A cue is not production-approved until a reviewer records fit, originality check, loop points, provenance, and usage scope.

### Task 4.3 — Add scene scoring and ducking

**Files:**

- Add `src/audio/score.ts`
- Add `src/audio/ducking.ts`
- Add `src/audio/mastering.ts`
- Modify `src/stages/assemble2.ts`
- Add `test/audio-mix.test.ts`

Support cue placement, fades, looping, stingers, narration-sidechain ducking, clipping detection, and delivery loudness checks.

### Task 4.4 — Run ACE-Step benchmark

**Files:**

- Add `bench/music.ts`
- Create `docs/benchmarks/ace-step-m4-pro.md`

Use fixed prompts/seeds and report generation time, peak memory, format, loop quality, dialogue fit, and reviewer score.

**Milestone gate:** reference episode includes an approved theme and at least three properly ducked scene cues with no clipping or silent sections.

---

## Milestone 5 — Supervised local image tools

**Goal:** Accelerate art production without letting generation redefine locked characters.

### Task 5.1 — Add MLX image provider

**Files:**

- Add `src/providers/image/types.ts`
- Add `src/providers/image/mlxFlux.ts`
- Add `test/mlx-flux.test.ts`

Support text, source image, up to three references, seed, and LoRA where the local API supports them. Store every input/output/revision hash.

### Task 5.2 — Add asset approval pipeline

**Files:**

- Add `src/application/assetReviewService.ts`
- Add `src/quality/identityRubric.ts`
- Add `test/asset-review.test.ts`

Generated images remain candidates until a human locks them. Character assets require model-sheet comparison and layer/rig conversion.

### Task 5.3 — Define artwork conversion workflow

Document and implement the steps from candidate raster image to:

- cleaned background plate;
- separated foreground/midground/background;
- vector or high-resolution cutout layers;
- canonical palette;
- rig attachment points;
- approved production asset.

**Milestone gate:** produce one approved environment pack and one prop pack through the UI with complete provenance.

---

## Milestone 6 — Experimental MLX LTX video provider

**Goal:** Add selective generative shots without compromising the deterministic core.

### Task 6.1 — Define the provider contract

**Files:**

- Add `src/providers/video/types.ts`
- Add `src/providers/video/mlxLtx.ts`
- Add `src/providers/video/ltxPresets.ts`
- Add `test/mlx-ltx.test.ts`

```ts
interface GenerateVideoShotRequest {
  prompt: string;
  negativePrompt?: string;
  firstFrameImage?: string;
  audioWav?: string;
  width: 704 | 480 | 768 | 512;
  height: 480 | 704 | 512 | 768;
  frameCount: number; // must satisfy 8N+1
  preset: "fast" | "good" | "quality" | "super-quality";
  seed: number;
}

interface GenerateVideoShotResult {
  mp4Path: string;
  modelRevision: string;
  artifactProbe: VideoArtifactProbe;
  providerInvocationId: string;
}
```

### Task 6.2 — Enforce strict conditioning

**Files:**

- Add `src/providers/video/conditioningQc.ts`
- Add `test/video-conditioning.test.ts`

Requirements:

- validate readable image and WAV before request;
- compute allowed frame count from audio;
- reject audio longer than policy cap rather than silently trimming it;
- verify output has audio when required;
- compare output first frame to reference using a declared threshold plus human review;
- reject known server warnings/fallbacks;
- expose hardcoded negative-prompt incompatibility and allow a patched/forked runtime if required.

### Task 6.3 — Run the LTX shot-pack benchmark

**Files:**

- Add `bench/ltx-shot-pack.ts`
- Add `fixtures/ltx-shot-pack/manifest.json`
- Create `docs/benchmarks/ltx-2.3-m4-pro.md`

Use the benchmark defined in the capability audit. Download the exact 26.7.9 selective bundle to `/Volumes/Misc`, measure actual disk use and peak unified memory, and pin model commit hashes.

### Task 6.4 — Gate shot selection

**Files:**

- Add `src/application/rendererPolicy.ts`
- Add `test/renderer-policy.test.ts`

Initial policy:

- deterministic: dialogue, teaching, close-up, continuity-critical, revision-heavy;
- LTX eligible: establishing, vision, transition, atmosphere, supervised hero shot;
- manual override requires a recorded reason and review.

**Milestone gate:** LTX is either promoted for named shot categories with benchmark evidence or remains disabled. “Installed” is not a promotion criterion.

---

## Milestone 7 — Creator UI and local control API

**Goal:** A non-developer can operate the system without editing JSON or TypeScript.

### Task 7.1 — Add local API

**Files:**

- Add `src/server/app.ts`
- Add `src/server/routes/projects.ts`
- Add `src/server/routes/episodes.ts`
- Add `src/server/routes/assets.ts`
- Add `src/server/routes/jobs.ts`
- Add `src/server/routes/reviews.ts`
- Add `test/server.test.ts`

Use schema-validated requests. Stream job progress with SSE. Bind to localhost by default.

### Task 7.2 — Add React/Vite studio

**Files:**

- Add `studio/` workspace
- Add `studio/src/pages/Projects.tsx`
- Add `studio/src/pages/Script.tsx`
- Add `studio/src/pages/Characters.tsx`
- Add `studio/src/pages/Storyboard.tsx`
- Add `studio/src/pages/Voices.tsx`
- Add `studio/src/pages/Music.tsx`
- Add `studio/src/pages/Render.tsx`
- Add `studio/src/pages/Review.tsx`

Required screens:

1. project setup;
2. source/script editor;
3. character bible and voice approval;
4. scene/shot storyboard;
5. per-shot renderer and preset;
6. asset/media library;
7. render queue and logs;
8. A/B output review;
9. final QC/export.

### Task 7.3 — Add timeline editing

**Files:**

- Add `studio/src/features/timeline/`
- Add API endpoints for timing edits
- Add end-to-end tests

Support dialogue timing, shot trims, cue placement, camera keys, pose keys, captions, and selected revisions without regenerating unrelated assets.

### Task 7.4 — Add model/storage preflight UI

Show:

- MLX Core status and version;
- installed models;
- required vs optional bundles;
- expected and actual disk use;
- `/Volumes/Misc` mount/free space;
- per-provider readiness;
- benchmark/promotion status.

Do not download a 39 GB bundle merely because a user opens a project.

**Milestone gate:** a non-developer creates and revises the reference episode entirely through the UI.

---

## Milestone 8 — Editorial review, delivery QC, and publishing

**Goal:** Nothing is called complete until editorial and technical gates pass.

### Task 8.1 — Add explicit review states

States:

- draft;
- script approved;
- character approved;
- storyboard approved;
- voices approved;
- shot approved;
- rough cut approved;
- final QC passed;
- published.

Every rejection records category, timestamp, reviewer, and required revision.

### Task 8.2 — Add final delivery gate

**Files:**

- Add `src/quality/deliveryGate.ts`
- Add `test/delivery-gate.test.ts`

Gate checks:

- valid MP4 streams;
- target dimensions/fps;
- no unapproved assets;
- no missing provenance/consent;
- no unexpected silence/black frames;
- caption presence and duration;
- audio clipping/loudness;
- frame/duration consistency;
- all required review decisions;
- final content hash and manifest.

### Task 8.3 — Keep publishing provider-gated

Retain `PUBLISH_PROVIDER=mock` until an explicit publication workflow is approved and tested. Publishing is a separate side effect from rendering.

**Milestone gate:** reference episode exports a master MP4, SRT, burned-caption accessibility copy, poster frame, provenance manifest, and QC report.

---

## Milestone 9 — Reference episode and release qualification

**Goal:** Prove the complete studio with one professional reference episode before scaling.

### Reference episode criteria

- 3–5 minutes;
- at least three reusable characters;
- narration and character dialogue;
- five or more environments/shots;
- real viseme alignment;
- approved music theme and scene cues;
- captions;
- at least one optional MLX-generated shot only if it passes the benchmark;
- complete provenance/consent;
- editable through the UI;
- resumable after forced interruption;
- reproducible from the pinned manifest.

### Release test matrix

1. clean install with no media models;
2. `/Volumes/Misc` mounted and absent;
3. MLX Core stopped and running;
4. fixture-only offline render;
5. Qwen TTS render;
6. ACE-Step cue generation;
7. LTX enabled/disabled;
8. job cancellation/restart;
9. invalid reference audio/image;
10. low disk space;
11. corrupted cache;
12. final QC rejection and correction;
13. sidecar and burned-caption exports;
14. exact rerender from locked artifacts.

### Definition of done

The application is production-ready only when:

- all automated tests pass;
- the reference episode passes human visual, audio, editorial, and theological review;
- no fixture or mock is used in the production master;
- the full workflow succeeds from the UI;
- every provider is observable, cancellable, and reproducible where possible;
- every asset has provenance and approval;
- final delivery QC passes;
- installation, model storage, backup, and recovery are documented;
- a second short episode reuses the same characters without manual code changes.

---

## Execution order and parallel workstreams

After Milestone 0, these tracks can proceed in parallel:

| Track | Work | Dependency |
|---|---|---|
| A — Core | domain, persistence, jobs, API | Milestone 0 |
| B — Deterministic animation | rigs, alignment, compositor, environments | Milestone 0 alignment contract |
| C — Local audio | Qwen TTS, ACE-Step, mix | MLX client + provenance |
| D — MLX experiments | FLUX and LTX benchmarks | storage/model preflight |
| E — Studio UI | project/storyboard/review screens | stable local API |
| F — Quality | probes, rubrics, delivery gate | begins in Milestone 0; continuous |

Do not begin LTX product integration before its standalone benchmark harness exists. Do not begin UI polish before the job/domain contracts are stable.

## Immediate next commit sequence

1. `test: make config and provider selection hermetic`
2. `test: establish honest proof and artifact probes`
3. `feat: add real alignment provider boundary`
4. `feat: add project schema and provenance records`
5. `feat: add SQLite persistence and asset store`
6. `feat: add persistent render jobs`
7. `feat: add strict MLX Core client`
8. `bench: add Qwen TTS and ACE-Step harnesses`
9. `feat: rebuild deterministic rig and shot primitives`
10. `bench: add LTX shot pack and renderer policy gate`
11. `feat: add local control API and studio UI`
12. `feat: add final review and delivery gate`

Each commit must leave `npm run typecheck` and `npm test` green. Benchmark documents must contain real output, not projected numbers.

## Risks that would change this plan

- **If deterministic 2D cannot meet the visual bar without excessive manual labor:** benchmark a rigged 3D or learned 2D animation system before expanding the SVG renderer.
- **If Qwen TTS lacks expressiveness:** keep a paid provider for final character voices while retaining local drafts.
- **If LTX passes identity and sync gates consistently:** expand its eligible shot categories, but retain deterministic dialogue fallback.
- **If LTX fails cartoon conditioning due to runtime defaults:** patch/fork the pinned MLXServe runtime or use direct `ltx-2-mlx`; do not hide the incompatibility in prompts.
- **If 169 GiB free becomes insufficient:** retain only promoted model variants and implement cache eviction before buying more API usage or storage.
- **If the creator needs collaboration:** add authenticated remote project sync only after the local workflow is reliable; do not expose the local MLX server directly.

## Lead-engineer sign-off

The plan intentionally rejects the seductive shortcut—making all scenes generative—because the project’s load-bearing requirements are reusable identity, exact dialogue revisions, real lip sync, and repeatability. The current deterministic proof is far below the desired visual bar, so keeping deterministic 2D is not an endorsement of the existing artwork; it is an endorsement of an editable production model that now needs professional execution.

The first engineering priority is **not** downloading LTX. It is making the baseline honest and green, then proving local voice, alignment, and one professional deterministic scene. LTX earns a production role only through the shot-pack benchmark.
