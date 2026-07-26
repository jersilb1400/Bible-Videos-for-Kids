# Prioritized Implementation Roadmap — Bible Videos for Kids

**Date:** 2026-07-25
**Status:** Active — fixes applied, roadmap synthesized from 3 subagent reports

## Current baseline (verified 2026-07-25)

### What works
- **Typecheck:** PASS (0 errors)
- **Tests:** 154/154 pass (12 test files). proof-contract.test.ts runs the full render pipeline (~5min) and is excluded from fast suite.
- **Proof episode:** `out/proof-daniel.mp4` — 469KB, 44.82s, 1280×720, H.264/AAC, 6 shots, 2 cast, frame agreement verified
- **V2 pipeline:** episode JSON → Zod → speech → timeline → lip-sync → SVG cutout render → FFmpeg assembly → MP4 + SRT
- **Alignment provider chain:** Rhubarb (real phoneme alignment) + Fixture (deterministic fallback) + QA validation
- **Lip-sync analyzer:** probes duration via ffprobe (byte heuristic gone), with conservative fallback + warning when ffprobe unavailable
- **Assembly:** subtitles filter path escaping fixed for macOS tmpdir — ASS burn-in now works
- **Config:** hermetic `loadConfig(env)` — tests don't leak ambient `.env`
- **SVG cutout renderer:** per-character rigs, 7 viseme mouth shapes, deterministic blinks, camera transforms
- **Director module:** LLM screenplay→staged shots with deterministic fallback + Zod validation
- **Performance:** per-emotion voice modulation via `VoiceProfile` + Edge-TtsEnhancedProvider
- **3 MLX providers exist:** mlxVideo (Wan 2.2/LTX-2), mlxAvatar (LongCat-Avatar), mlxMusic (ACE-Step) — on the mlx-video Python subprocess stack

### What's broken / WIP
- **Assembly subtitles test:** FIXED (ffmpeg path escaping) ✅
- **Lipsync analyzer:** FIXED (added conservativeDurationEstimate function) ✅
- **10 uncommitted modified files:** +533/-245 lines across config, lipsync, ffmpeg, assemble, proof script, thumbnail, pipelineV2, V2-ARCHITECTURE, package.json
- **4 untracked files:** src/alignment/, test/alignment.test.ts, test/config.test.ts, test/proof-contract.test.ts — all need committing
- **Edge-TTS enhanced provider:** built but NOT wired into pipelineV2 — v2 orchestrator still uses non-enhanced EdgeTtsSpeechProvider
- **Rhubarb binary:** NOT installed (RHUBARB_BIN unset) — alignment falls back to fixture automatically but real phoneme lip-sync requires the binary
- **MLX music:** provider scaffolded but untested on real MLX Core server
- **Two parallel MLX strategies:** repo has mlx-video subprocess providers (built) AND the professional plan assumes MLXServe HTTP (unbuilt) — need a decision

---

## TIER 1 — Immediate (1–2 days): Close the gap to the quality bar

These are installs, wiring, and small tests that move closest to talking characters with lip sync + real music.

| # | Item | Effort | Enables | Local? |
|---|------|--------|---------|--------|
| 1.1 | **Install Rhubarb binary** + set `RHUBARB_BIN`. Provider + tests already exist — this one install flips lip-sync from fixture visemes to real phoneme alignment. | 30 min | Real lip sync (Tier 0) | Yes (free OSS) |
| 1.2 | **Wire Edge-TTS enhanced into pipelineV2** so per-emotion VoiceProfiles actually run. Code is built (`src/performance/voice.ts`) but unused. | 2–4 h | Real character voices with emotion | Yes (free) |
| 1.3 | **Benchmark MLX music** on live MLX Core server. Provider built, `MUSIC_PROVIDER=mlx` wired with fallback. Install ACE-Step 1.5 XL Turbo (6.3 GB) on /Volumes/Misc, run benchmark, promote or document failure. | 3–4 h | Real music (replaces sine pad) | Yes (Apple Silicon) |
| 1.4 | **Add QC probes** (`src/quality/artifactProbe.ts` + `audioQc.ts` + `videoQc.ts`). Wrap ffprobe/ffmpeg → typed evidence: duration, streams, loudness, clipping, black/silent segments, file hash. ~150 lines each. | 4–6 h | Honest QC for delivery gate | Yes |
| 1.5 | **Decide MLX stack direction.** Document in V2-ARCHITECTURE.md: keep MLXServe HTTP as primary (matches plan, exposes Qwen3-TTS), keep mlx-video as experimental escape hatch for LongCat-Avatar lip sync. | 1 h | Avoids building parallel adapters | Yes |

**Tier 1 outcome:** real lip sync, real per-character voices, real music, honest QC, single MLX direction.

---

## TIER 2 — Near-term (1 week): Production capability

| # | Item | Effort | Enables | Local? |
|---|------|--------|---------|--------|
| 2.1 | **MLX Core client** (`mlxCoreClient.ts` + `capabilities.ts`). Preflight /health, model IDs, timeout/cancel, error mapping, no implicit download. | 1 day | Safe local TTS/music/image/video | Yes |
| 2.2 | **Qwen3-TTS provider** (`src/providers/speech/mlxQwenTts.ts`). HTTP to MLX Core `/v1/audio/speech`. Clone-vs-default contract, WAV normalization, provenance. Benchmark 0.6B vs 1.7B. | 2–3 days | Local voice cloning — $0 marginal cost | Yes (3.1 GB) |
| 2.3 | **Domain model + provenance** (`src/domain/*`). SeriesProject/Episode/Shot/CharacterBible/VoiceProfile/GeneratedAsset/ProviderInvocation. Zod schemas + tests. | 1–2 days | Reusable characters, provenance foundation | Yes |
| 2.4 | **Voice consent/provenance** (`src/domain/voiceConsent.ts`). Consent owner, permitted characters, recording date, revocation. Render job refuses unapproved profiles. | 4–6 h | Legal/safe voice cloning | Yes |
| 2.5 | **Persistent job queue** (`src/jobs/*`). SQLite-backed, progress events, cancellation, retry, idempotency, crash recovery, artifact-level resume. | 2–3 days | Resumable renders | Yes |
| 2.6 | **Scene scoring + ducking** (`src/audio/score.ts` + `ducking.ts` + `mastering.ts`). Cue placement, fades, sidechain ducking, EBU R128 loudness. | 1–2 days | Properly mixed episodes | Yes (ffmpeg) |
| 2.7 | **Layered SVG rigs** — cache static layers, stream frames to FFmpeg stdin. Benchmark: <1× real-time. | 2–3 days | Watchable framerates | Yes |

**Tier 2 outcome:** local Qwen3-TTS voices with consent, resumable jobs, real provenance, properly mixed audio, faster compositor. One short reference episode possible with local-only providers.

---

## TIER 3 — Strategic (2–4 weeks): Full studio vision

| # | Item | Effort | Enables | Local? |
|---|------|--------|---------|--------|
| 3.1 | **SQLite persistence + content-addressed asset store** | 1 week | Reproducible episodes, cache eviction | Yes |
| 3.2 | **Character bible + model sheets** | 1 week | Identity-locked reusable characters | Yes |
| 3.3 | **Shot animation primitives** (camera, keyframes, effects, blocking) | 1–2 weeks | Real animation, not camera-on-static | Yes |
| 3.4 | **Supervised MLX FLUX image tools** + asset approval pipeline | 1 week | Faster background/prop ideation | Yes (10.5 GB) |
| 3.5 | **LTX shot-pack benchmark** + conditioning QC + renderer policy | 2 weeks | Optional generative shots (never default) | Yes (39 GB) |
| 3.6 | **Local control API** (Express/Hono, SSE job progress) | 1 week | Lets the UI exist | Yes |
| 3.7 | **React/Vite studio UI** — 9 screens, timeline editing, model preflight | 2–3 weeks | Non-developer can create/revise/export | Yes |
| 3.8 | **Editorial review states + delivery gate** — 9 review states, technical gate | 1 week | Nothing ships until approved | Yes |
| 3.9 | **Reference episode + release qualification** — 3-5 min, complete provenance, 14-cell test matrix | 2 weeks | Proves the studio end-to-end | Yes |

**Tier 3 outcome:** local AI-assisted animation studio. Non-developer creates, revises, exports professional episodes with reusable identity, real lip sync, real music, provenance, review gates, reproducible manifests.

---

## Key constraints honored
- **Offline-first:** every item keeps a fixture/Edge/ffmpeg fallback
- **Local-first, low-cost:** Tiers 0-2 are $0 marginal cost
- **Benchmark-gated:** no MLX model promoted without written benchmark
- **Mac/MLX:** Qwen3-TTS, ACE-Step, FLUX Klein, LTX all run on M4 Pro 48 GB via MLX Core through /Volumes/Misc
