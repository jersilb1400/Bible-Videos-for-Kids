# MLX Core / MLXServe Capability Audit

**Audit date:** 2026-07-22

**Installed target:** MLX Core 26.7.9 on MacBook Pro `Mac16,7`, M4 Pro, 48 GB unified memory

**Project:** Bible Videos for Kids

**Status:** Evidence-backed research and architecture decision record; media-model benchmarks remain gated

## Conclusion

Build an **AI-assisted local animation studio**, not a one-click text-to-video wrapper.

The production architecture should be:

1. **Deterministic 2D as the editable episode spine**, after replacing the current proof-quality renderer with professional assets, real viseme timing, pose/camera animation, backgrounds, effects, music, and review gates.
2. **MLX Core for local voice cloning/TTS and music**, subject to on-device benchmark and consent/licensing controls.
3. **MLX Core + LTX-2.3 only as an optional generative-shot backend** for short establishing shots, atmosphere, transitions, dream/vision moments, and experiments. It must not be the default dialogue renderer until it proves character identity, cartoon-style retention, and audio/video synchronization on the target Mac.
4. **MLX image generation for ideation, backgrounds, props, and supervised asset variants**, not as an automatic replacement for locked character rigs.
5. **Human approval gates** at script, character bible, voice, storyboard, generated shots, and final master. “Professional” quality cannot be inferred from successful API calls.

This conclusion is **high confidence**. It is based on the current project artifacts, two reproducible proof renders, installed MLX Core state, current MLXServe 26.7.9 source, model metadata, and independent specialist reviews. The residual uncertainty is actual model quality and speed on this M4 Pro because the large media bundles have not been downloaded or benchmarked.

## Confidence vocabulary

- **verified** — observed directly, re-derived, or read from a pinned primary source.
- **high confidence** — converging direct evidence, but not locally benchmarked end to end.
- **likely** — reasonable engineering inference that can still fail in practice.
- **speculative** — hypothesis requiring a benchmark.

## Sources and reproducibility boundary

### Current project and machine

- Local repository at `/Users/jeremysilbernagel/Documents/Jeremy Apps/Bible-Videos-for-Kids`.
- Branch `feat/deterministic-2d-rewrite`, HEAD `24a4f36a41f938ee580181581715b419bd95fd4a` during the audit.
- Installed MLX Core bundle version `26.7.9`; local server at `http://127.0.0.1:11234`.
- M4 Pro, 48 GB unified memory.
- Hugging Face cache symlinked to `/Volumes/Misc/huggingface_cache`; `/Volumes/Misc` had 169 GiB free during the audit.

### MLXServe primary sources

- [MLX Core video guide](https://mlxserve.com/video-generation/)
- [MLX Core talking-character section](https://mlxserve.com/video-generation/#talking)
- [MLX Core voice-cloning guide](https://mlxserve.com/voice-cloning/)
- [MLX Core music-generation guide](https://mlxserve.com/music-generation/)
- [MLX Core image-generation guide](https://mlxserve.com/image-generation/)
- [MLX Core API reference](https://mlxserve.com/api/)
- [MLXServe 26.7.9 source](https://github.com/ddalcu/mlx-serve/tree/v26.7.9)
- [Video preset definitions](https://github.com/ddalcu/mlx-serve/blob/v26.7.9/app/Sources/MLXServe/Services/MediaGen.swift)
- [Selective media bundle definitions](https://github.com/ddalcu/mlx-serve/blob/v26.7.9/app/Sources/MLXServe/Services/MediaBundle.swift)
- [Native generation handlers](https://github.com/ddalcu/mlx-serve/blob/v26.7.9/src/gen.zig)
- [MLXServe video integration test](https://github.com/ddalcu/mlx-serve/blob/v26.7.9/tests/test_video_gen.sh)
- [MLXServe music integration test](https://github.com/ddalcu/mlx-serve/blob/v26.7.9/tests/test_music_gen.sh)

### Model sources

- [LTX-2.3 official model](https://huggingface.co/Lightricks/LTX-2.3)
- [LTX-2.3 Q4 MLX bundle](https://huggingface.co/dgrauet/ltx-2.3-mlx-q4)
- [LTX-2 MLX runtime](https://github.com/dgrauet/ltx-2-mlx)
- [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS)
- [ACE-Step 1.5](https://github.com/ace-step/ACE-Step-1.5)
- [FLUX.2 Klein 4B](https://huggingface.co/black-forest-labs/FLUX.2-klein-4B)
- [Krea-2 Turbo](https://huggingface.co/krea/Krea-2-Turbo)
- [Hunyuan3D-2.1](https://huggingface.co/tencent/Hunyuan3D-2.1)
- [LTX-2.3 model license](https://huggingface.co/Lightricks/LTX-2.3/blob/main/LICENSE)

Website copy, model cards, and source comments are evidence of documented intent; they are not local quality or performance benchmarks.

---

## 1. As-built project baseline

### What exists — **verified**

The current repository contains a real Node/TypeScript pipeline with these stages:

`ingest → canonicalize → validate → plan → speech → render → captions → assemble`

Evidence:

- `src/pipelineV2.ts`
- `src/stages/`
- `src/renderers/svgCutout.ts`
- `src/providers/speech.ts`
- `src/lipsync/analyze.ts`
- `src/stages/assemble2.ts`

Existing useful foundations:

- manifest-driven episode input;
- stage workspaces, hashes, logs, and resume behavior;
- schema validation;
- renderer and speech-provider boundaries;
- FFmpeg assembly;
- sidecar SRT generation;
- deterministic fixture mode;
- a functioning SVG-cutout renderer;
- tests for many structural pipeline behaviors.

### What the proof actually proves — **verified**

The canonical proof was executed twice with:

```bash
./node_modules/.bin/tsx scripts/render-proof.ts
```

Two consecutive runs at repository HEAD `df689ef` produced identical SHA-256 hashes:

```text
31c451127f4b17fd4276240c8f89a42b88911475dcaa8ebbc2eb9ec78d23aa62  out/proof-daniel.mp4
affe4bad81f5ba873c579e7aaae1a9faf5ebeaf790358e1cd7abf20e6e62accc  out/proof-daniel.srt
```

That proves repeatability for the current fixture-backed proof path at the same code, inputs, dependency, and environment state. It does **not** provide a golden hash across code revisions and does **not** prove professional quality. The previous documented hashes were produced before later changes to the SVG renderer, assembler, and timeline/types code.

The rendered MP4 was:

- H.264, 1280×720, 30 fps;
- AAC mono, 48 kHz;
- 44.820 seconds;
- 1,344 video frames;
- 303,579 bytes;

The script reported 1,347 frames, but the encoded stream contained 1,344. Metadata and the artifact disagree by three frames. This is a real bookkeeping defect.

Two current-HEAD renders took 138.4 and 101.7 seconds for a 44.820-second artifact, approximately 3.09× and 2.27× final duration. Their outputs were byte-identical, but the wall-clock variation means these runs are not a controlled performance benchmark. The current Sharp-per-frame implementation is deterministic under the checked conditions but not yet fast.

### What the proof does not prove — **verified**

The proof is not evidence of production-ready animation:

- `scripts/render-proof.ts` explicitly uses the fixture speech provider.
- The fixture produces silent structural audio, not real voices.
- `ffmpeg` volume analysis measured about `-91 dB` mean and `-91 dB` max, effectively silence.
- No music is present.
- The MP4 has no embedded subtitle stream; the SRT is a sidecar.
- The contact sheet shows flat color backgrounds, one simple character rig, basic poses, repeated framing, and no professional environment art, secondary characters, shot staging, lighting, or effects.
- The current mouth analysis estimates duration from compressed audio file bytes as if they were raw 16-bit PCM. That cannot produce trustworthy viseme timing for MP3 TTS output.
- The proof validates pipeline mechanics, not believable lip sync, acting, professional art, or episode-level storytelling.

### Test state — **verified**

`npm run typecheck` passed.

`npm test` reported:

```text
61 tests
60 passed
1 failed
```

The failure is in `test/pipeline.test.ts`: the legacy full pipeline invoked OpenRouter and received HTTP 401. The config module loads `.env` at module-import time before the test clears provider variables. This is a test-isolation/configuration bug, not a successful green baseline.

### Product gaps — **verified**

The current repository is a CLI/library prototype, not a complete creator application. It does not yet contain:

- a studio UI;
- project/episode management;
- a character-bible editor;
- professional reusable rigs and environment libraries;
- reliable phoneme/viseme alignment;
- a production music stage;
- real local MLX TTS/music/video providers;
- an approval/revision workflow;
- a persistent job queue with cancellation and progress;
- model installation/preflight UX;
- local benchmark reports;
- output-level license/provenance records;
- quality scoring or final delivery checks.

---

## 2. MLX Core state on this machine

### Installed and reachable — **verified**

- MLX Core version: `26.7.9`.
- Native server: `http://127.0.0.1:11234`.
- `/health` returned healthy during the audit.
- `/v1/models` listed only installed chat models:
  - `mlx-community/gemma-3-4b-it-4bit`
  - `mlx-community/Qwen2.5-7B-Instruct-4bit`
- No video, TTS, music, or image model was installed at audit time.

Therefore every media conclusion below is a source-level capability statement unless explicitly called a local artifact result.

### Storage reality — **verified with source disagreement**

MLXServe 26.7.9 has conflicting size comments:

- `MediaGen.swift` describes the selective LTX first-run download as about 26 GB and approximate peak RAM as 24 GB.
- `MediaBundle.swift` allowlists the dev transformer, distilled transformer, upscaler, VAE encoder/decoder, audio VAE, vocoder, connector, and Gemma text encoder, then estimates 39 GB.
- The website markets the download at roughly 50 GB.
- The complete Q4 Hugging Face repository is larger because it contains alternative assets that MLX Core does not need.

Use **39 GB as the application planner’s current estimate**, but measure the selected files and peak memory during the local benchmark. Do not reserve based only on the older 26 GB label.

A representative optional local stack is approximately:

| Bundle | Planning estimate |
|---|---:|
| LTX-2.3 selective bundle | 39.0 GB |
| Qwen3-TTS 1.7B 8-bit | 3.1 GB |
| ACE-Step 1.5 XL Turbo 8-bit | 6.3 GB |
| FLUX.2 Klein 4B | 10.5 GB |
| **Combined** | **58.9 GB** |

With 169 GiB free, this selective app-defined set fits on `/Volumes/Misc`, but it leaves about 110.1 GiB before caches, temporary frames, videos, and alternate models. The storage estimate is not universal: the website advertises roughly 50 GB for video, while the complete Hugging Face Q4 repository metadata is about 55.6 GiB. Pin exact files before reserving space. Keep media models and intermediate frames on `/Volumes/Misc`; do not build a redundant model zoo.

---

## 3. Video and talking characters

### Capability matrix

| Claim | Finding | Confidence |
|---|---|---|
| Local text-to-video | MLX Core exposes LTX-2.3 Q4 and an OpenAI-like `POST /v1/video/generations`. | **verified** |
| First-frame image conditioning | The request accepts `image_base64`; the selective bundle includes a VAE encoder. | **verified** |
| Audio conditioning | The request accepts `audio_base64`; the runtime muxes generated or supplied audio into MP4. | **verified** |
| Text-generated sound | LTX-2.3 can generate synchronized audio when audio weights are present. | **verified as documented**, not locally tested |
| “Talking character” workflow | The guide describes quoted dialogue and reference-audio workflows. | **verified as publisher documentation** |
| Accurate lip sync | No phoneme-error, offset, cartoon, or multi-speaker benchmark was found. | **speculative until tested** |
| Cross-shot identity | No guarantee or series-level benchmark was found. | **speculative and high risk** |
| Exact cartoon model-sheet adherence | Not documented; current guided code contains a default negative prompt that includes “cartoonish rendering” and “3D CGI look.” | **high-confidence incompatibility risk** |
| Long-form episodes | The 26.7.9 preset caps the M4-Pro-oriented frame ladder at 193 frames, approximately 8 seconds at 24 fps. | **verified** |
| Deterministic editing | Output is raster MP4; no reusable vector layers, pose keys, or semantic character parts are returned. | **verified architectural limitation** |

### 26.7.9 preset facts — **verified**

The UI preset defines:

- model: `dgrauet/ltx-2.3-mlx-q4`;
- fixed 24 fps;
- 704×480, 480×704, 768×512, and 512×768 resolution choices;
- frame counts satisfying `8N+1`;
- practical cap: 193 frames on this class of Mac;
- 49-frame fast, 97-frame good, and 97-frame two-stage quality defaults;
- optional starting image and audio;
- audio longer than the selected video is trimmed.

These are implementation limits of the current MLX Core preset, not universal limits of every LTX implementation.

### API behavior that the provider must handle — **verified**

The native request supports fields including:

- `model`
- `prompt`
- `negative_prompt`
- `width`
- `height`
- `num_frames`
- `num_steps`
- `guidance_scale`
- `stg_scale`
- `seed`
- `image_base64`
- `audio_base64`
- `pipeline`

The result is an MP4 payload. The application adapter must:

1. query `/health` and `/v1/models`;
2. reject if the exact model/bundle is not ready;
3. read the supplied audio duration with `ffprobe`;
4. compute the smallest allowed `8N+1` frame count that covers the audio, or reject if it exceeds the chosen cap;
5. validate reference-image and WAV formats before the call;
6. request an explicit preset rather than relying on server defaults;
7. decode and persist the MP4 atomically;
8. verify video/audio streams, dimensions, fps, duration, and first-frame conditioning after generation;
9. store prompt, seed, model revision, preset, input hashes, output hash, and elapsed time;
10. fail closed if image/audio conditioning was ignored or degraded.

The current MLXServe code may continue without optional audio/VAE assets and can produce silent or text-only-conditioned output. That graceful degradation is useful for demos but unacceptable for a strict production provider.

### Adversarial conclusion for LTX

**Reject LTX as the default episode renderer.**

Reasons:

1. No verified cross-shot character identity.
2. No verified model-sheet/style lock for a 2D children’s series.
3. No verified phoneme-accurate lip sync.
4. Approximately eight-second clips require many generations and continuity repairs.
5. Raster output is difficult to revise precisely.
6. Source defaults contain a negative prompt hostile to cartoon/CGI styling in guided modes.
7. The 39 GB bundle is a major memory/storage resident compared with deterministic rendering.
8. Failed generations cost time even if marginal API cost is zero.

**Accept LTX as an experimental selective-shot provider** after it passes the benchmark suite. Best candidates:

- establishing shots;
- dream/vision sequences;
- atmospheric motion;
- transitions;
- crowd or environmental inserts where exact identity is not load-bearing;
- supervised hero shots that can be regenerated or discarded.

Do not initially use it for:

- alternating two-character dialogue;
- scripture-teaching close-ups where lip sync is prominent;
- shots requiring exact clothing/prop continuity;
- scenes that will need precise revisions;
- long continuous performances.

---

## 4. Voice and TTS

### What MLX Core supports — **verified**

MLX Core 26.7.9 exposes native Qwen3-TTS models through `POST /v1/audio/speech` and supports reference-audio voice cloning. The app catalogue includes:

| Model | App estimate | Intended role |
|---|---:|---|
| Qwen3-TTS 0.6B Base 8-bit | 2.0 GB download, 3 GB approximate peak RAM | default/fast cloning |
| Qwen3-TTS 0.6B Base bf16 | 2.5 GB, 4 GB RAM | higher-precision small model |
| Qwen3-TTS 1.7B Base 8-bit | 3.1 GB, 5 GB RAM | larger cloning model |
| Qwen3-TTS 1.7B Base bf16 | 4.5 GB, 7 GB RAM | highest listed precision |

The current native API accepts text plus `ref_audio` as a base64 WAV. The installed app recommends roughly eight seconds of clean reference audio.

The upstream Qwen3-TTS model is Apache-2.0 licensed. This does not waive consent, likeness, or performer-rights requirements for cloned voices.

### Important limitations — **verified/high confidence**

- The native handler does not expose a rich emotion/style control surface comparable to a full commercial voice API.
- The endpoint does not provide phoneme timestamps.
- It may continue with a default speaker if reference audio is invalid; the application must fail closed when cloning is required.
- Voice quality, child-friendly expressiveness, pronunciation of Biblical names, and run-to-run consistency are not locally measured.
- Cloning a voice requires explicit, recorded consent and a provenance record. Do not clone children or third parties without appropriate consent and review.

### Recommendation

Use Qwen3-TTS as the primary **local benchmark candidate**, not as an automatic replacement before listening tests.

Benchmark 0.6B 8-bit and 1.7B 8-bit using the same clean, consented adult-character reference set. Evaluate:

- intelligibility;
- Biblical-name pronunciation;
- emotional range;
- speaker consistency across scenes;
- generation speed and memory;
- noise and clipping;
- whether children can distinguish characters;
- whether repeated lines remain natural.

Keep a fallback provider until Qwen passes. Persist final approved WAVs so rerenders never depend on regenerating a voice.

---

## 5. Music generation

### What MLX Core supports — **verified**

MLX Core uses `ddalcu/ACE-Step-1.5-XL-Turbo-MLX-Serve-8bit` through `POST /v1/audio/music-generations`.

The current request surface includes:

- `prompt`
- optional `lyrics`
- `duration` from 10 to 600 seconds;
- `bpm`
- `keyscale`
- `timesignature`
- `vocal_language`
- `instrumental`
- `seed`
- `steps`
- `guidance_scale`
- `format`

The 26.7.9 app estimates about 6.3 GB download and 9 GB approximate peak RAM.

### What it does not solve — **high confidence**

- It does not produce a story-aware score automatically.
- It does not expose stem separation in this API.
- It does not perform dialogue ducking or loudness normalization.
- It does not guarantee non-resemblance to existing music.
- An open model license is not a blanket guarantee that every generated output is free of third-party rights issues.
- A ten-minute generation can still be musically repetitive or narratively mismatched.

The inspected ACE-Step weights use an MIT license, but that license does not warrant that generated tracks are original or non-infringing.

### Recommendation

Use ACE-Step to generate and curate a **small approved theme library**:

- opening/title theme;
- warm narration bed;
- wonder/discovery;
- gentle tension;
- celebration;
- reflective/prayer ending;
- transitions and stingers.

Generate instrumental-first beds, manually approve them, record provenance and prompts, create normalized loops, and reuse them. Add automated dialogue ducking and final loudness checks in FFmpeg. Do not regenerate a wholly new unreviewed score for every episode by default.

---

## 6. Image and other MLX capabilities

### FLUX.2 Klein image generation — **verified as available**

MLX Core supports local image generation/editing with:

- text-to-image;
- image-to-image editing;
- up to three reference images in the documented workflow;
- LoRA in the UI/API path;
- a 1024×1024 native FLUX.2 Klein path.

The inspected FLUX.2 Klein 4B model is Apache-2.0 licensed. That makes it the cleaner baseline image candidate than the available Krea alternative; it does not prove better output quality or series consistency.

Useful roles:

- concept art;
- background plates;
- prop variants;
- texture/effect plates;
- storyboard thumbnails;
- supervised character-sheet exploration.

Do not automatically treat generated character sheets as production rigs. They need human selection, legal/provenance records, cleanup, vectorization or layer separation, canonical turnarounds, color palettes, mouth sets, hand poses, and pose validation.

### Krea-2 Turbo — **conditional alternative, not a default**

The MLXServe catalogue also includes Krea-2 Turbo through the image endpoint, with variable dimensions and image-to-image support. Its published app footprint is much larger than FLUX.2, and its custom license includes an under-US$1-million affiliated-revenue condition, filtering obligations, and termination provisions. Keep it behind legal review and a removable feature flag; do not make project reproducibility depend on it.

### Speech-to-text — **not an automatable MLXServe media endpoint**

The 26.7.9 application source contains transcription features for app/Telegram workflows, but the native media server does **not** expose an OpenAI-compatible `/v1/audio/transcriptions` endpoint. Treat ASR as an external dependency until a pinned, testable API provider is selected. Use ASR only as a dialogue/caption QA signal; ordinary ASR timestamps do not replace forced alignment or phoneme timing for precise mouth animation.

### Hunyuan3D-2.1 generation — **verified as available; defer**

MLXServe exposes Hunyuan3D-2.1 through `POST /v1/3d/generations`, producing GLB assets from an input image with an optional PBR-texture stage. The publisher states that the stack runs on 16 GB Apple Silicon, but it has not been locally benchmarked and uses Tencent's custom model license. Local 3D generation could eventually help with props or environment blocking, but the current pipeline does not consume meshes. It is not on the critical path for professional 2D episodes.

### Confirmed media-pipeline gaps

MLXServe 26.7.9 does not provide a standalone still-image upscaling endpoint, sound-effects generator, stem separator, mastering/ducking facility, or forced aligner. LTX's internal video upscaler is part of that video bundle, not a general image-upscaling service. These remain explicit external-tool or new-provider dependencies.

---

## 7. Decision record

| Decision | Supporting case | Strongest attack | Lead decision |
|---|---|---|---|
| Deterministic 2D episode spine | identity, editability, reproducibility, no generation drift | current renderer is visibly proof-quality and slow; professional rigs are labor-intensive | **Keep, but rebuild the renderer and asset system before calling it production** |
| MLX/LTX default full-episode renderer | local A/V generation and zero API invoice | no series consistency, short clips, raster-only revisions, unverified lip sync, cartoon-negative prompt | **Reject** |
| MLX/LTX selective-shot backend | optional image/audio conditioning and local generation | failures still consume time and continuity repair | **Adopt behind an experimental gate** |
| Qwen3-TTS primary voice | private, local, reusable cloned characters | expressiveness/timing/consent not yet proven | **Benchmark, then promote if it passes** |
| ACE-Step automatic per-episode score | local long-form generation | no narrative scoring, stems, or rights guarantee | **Generate a curated reusable library first** |
| FLUX for locked character production | references and local edits | raster inconsistency and no rig layers | **Use for supervised ideation/backgrounds; human-lock reusable rigs** |
| “Fully automated” creator | attractive UX promise | hides quality, consent, theology, and continuity failures | **Build AI-assisted studio with review gates** |
| “Zero cost” claim | no per-call vendor fee | electricity, storage, operator review, failed renders, and hardware time remain | **Call it low marginal cost, not free** |

---

## 8. Required benchmark suite before model adoption

### LTX shot pack

Run the same locked inputs with fast, good, and quality presets:

1. single-character narration close-up;
2. supplied-image plus supplied-audio talking shot;
3. two-character alternating dialogue;
4. full-body gesture and camera move;
5. exact clothing/prop continuity shot;
6. establishing shot with no load-bearing character identity;
7. stylized 2D reference designed to expose the hardcoded cartoon-negative-prompt problem;
8. repeat each seed and repeat across three seeds.

Record:

- model revision and selected bundle files;
- generation time;
- peak unified memory;
- output duration, fps, dimensions, and streams;
- identity/model-sheet rubric;
- first-frame adherence;
- mouth-to-audio offset rubric;
- off-speaker mouth movement;
- temporal artifacts;
- audio quality;
- prompt adherence;
- pass/fail and reviewer notes.

Promotion gate: LTX remains experimental until the exact intended shot category passes a predeclared quality rubric consistently. One impressive sample is not evidence.

### TTS pack

- three approved character voices;
- narration, dialogue, whisper, excitement, sadness, and prayer tones;
- Biblical names and uncommon vocabulary;
- short and long lines;
- repeated generations for consistency;
- blind listening review;
- independent ASR transcription as a QA signal;
- real phoneme alignment output.

### Music pack

- one 60-second instrumental cue for each approved emotional category;
- loop-boundary test;
- dialogue masking and ducking test;
- clipping and loudness check;
- reviewer fit score;
- license/provenance record.

---

## 9. Residual risks

1. **Model quality:** still unverified on the target Mac.
2. **Model drift:** MLX Core, repositories, and APIs are changing quickly; pin versions and model revisions.
3. **Licensing:** MLXServe software is MIT, but each model has its own terms. LTX uses the LTX-2 Community License rather than MIT/Apache. Entities and affiliates with aggregate annual revenue at or above US$10 million need the commercial-license path. Its Attachment A also requires intelligible machine-generated-content disclosure and imposes additional use restrictions. The license applies to the model; output-level third-party risks still require review.
4. **Consent:** voice cloning requires explicit consent and provenance.
5. **Character consistency:** generative metrics do not substitute for human model-sheet review.
6. **Theological/editorial correctness:** scripture and interpretation require human review.
7. **Storage:** 169 GiB free is enough for the initial planned stack but not for duplicate model variants plus a large render cache.
8. **Graceful degradation:** MLXServe can continue without optional conditioning assets; production adapters must reject silent or unconditioned fallbacks.
9. **Current proof quality:** deterministic output is reproducible, but reproducibility is not professional visual quality.

## Final architectural judgment

**Verified:** the project has a functioning, reproducible pipeline skeleton.  
**Verified:** the current proof is silent, structurally simple, and not professional-ready.  
**Verified:** MLX Core 26.7.9 exposes useful local video, voice, music, image, and optional 3D-generation capabilities. Its native media API does not expose transcription, forced alignment, standalone image upscaling, sound-effects generation, stem separation, or mastering.  
**High confidence:** local voice and curated music are the most immediately valuable MLX integrations.  
**High confidence:** deterministic assets remain the safest path for reusable characters and exact revisions.  
**Likely:** LTX can add value to selected short shots.  
**Speculative:** LTX can meet the project’s talking-character quality bar without substantial curation or a different runtime/fine-tune.

The next artifact is the implementation plan in `docs/plans/2026-07-22-professional-cartoon-studio-plan.md`.
