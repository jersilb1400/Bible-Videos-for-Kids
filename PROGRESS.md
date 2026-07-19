## 2026-07-19 — Media Production Direction: Talking Characters Pivot

### Status: PIVOT DECISION — awaiting implementation

The current FLUX + cinematic pipeline produces **narrated storybook** style (static images with camera motion + particles + Edge-TTS narration). After generating a full test episode (`out/2026-07-19-233ff279/episode.mp4`, 2:55, 30.7MB, 1080p) and comparing to the reference target (Minno "Laugh and Grow Bible" — 2D animated talking characters with lip-sync, character dialogue, proper music), the user has decided the current approach does not meet the quality bar.

**What the user wants:** Talking characters with lip-sync, character dialogue (not all narration), actual animation (not camera motion on static images), proper music (not sine pad), consistent colors.

### Reference target
- YouTube: Minno "Laugh and Grow Bible for Kids" (`https://youtu.be/HyARO8fmqy4`)
- Style: 2D animated, talking characters, lip-sync, character dialogue + occasional narration
- Duration: ~5-10 min episodes

### Provider evaluation (verified July 2026)

| Provider | Cost/Episode | Talking Characters | Lip Sync | Character Consistency | GPU Needed |
|----------|-------------|-------------------|----------|----------------------|------------|
| **Current (fal+cinematic)** | $0.50-3 | ❌ | ❌ | Prompt-based | No |
| **Higgsfield MCP (Starter)** | Free test | ✅ (Soul ID) | ✅ `sync_lipsync_3` | Soul ID (trained) | No |
| **Higgsfield MCP (Pro)** | ~$20-100 | ✅ | ✅ | ✅ | No |
| **Kling.ai MCP (direct)** | ~$38 | ✅ | ✅ Native API | Reference image per call | No |
| **ComfyUI self-hosted** | ~$0.18 | ✅ (Wan + LivePortrait) | ✅ | IP-Adapter | Yes (Hetzner/RunPod) |

### Key findings
1. **Higgsfield MCP** — already installed and tested. Starter plan (320 free credits) works for images. Video needs Pro. **Bonus/free credits CANNOT be used on MCP/CLI.**
2. **Kling.ai MCP** — official MCP at `https://kling.ai/mcp`. Per-second billing ($0.042-$0.14/s). Native lip sync ($0.07/5s) + TTS ($0.035/call) + Avatar. **Bonus credits not usable on MCP either — must buy paid credits.**
3. **Plan 2.0** (`docs/plan-2.0.md`) — targets narrated storybook with Wan 2.1 ambient motion, NOT talking characters. Missing lip-sync stage, character dialogue schema, and proper music. 70% right but wrong output format.

### What needs to change (agreed direction)
1. **Story schema** — add `Scene.dialogue[]` (speaker, line, emotion) alongside `Scene.narration`
2. **Lip-sync stage** — new stage between animation and assembly
3. **Music** — move from Phase 4 polish to Phase 1 (sine pad is unshippable)
4. **Provider tiering** — Higgsfield/Kling as immediate no-GPU path, ComfyUI as cost optimization
5. **Character dialogue** — rewrite stories as scenes with character lines, not pure narration

### Next step
User reviewing whether to use Kling.ai direct MCP or Higgsfield MCP as the primary no-GPU production path. Awaiting decision to begin implementation.

---

## 2026-07-05 — Visual Quality Pivot: FLUX Keyframes + Cinematic Animation — COMPLETE

### Done
- [x] **FLUX 2 keyframe provider** — `src/providers/falFlux.ts`: fal.ai FLUX 2 integration (~$0.02-0.05/1080p image)
- [x] **Pixar-style prompt builder** — `src/providers/promptBuilder.ts`: cartoon-optimized prompts with character consistency
- [x] **Cinematic camera motion** — `src/providers/cameraMotion.ts`: FFmpeg zoompan (zoom-in/out, pan-L/R/U/D, drift) + 1920×1080 output
- [x] **Particle overlays** — `src/providers/particles.ts`: sparkles, fireflies, stars, sunbeams, clouds via lavfi
- [x] **Edge-TTS provider** — `src/providers/edgeTts.ts`: free Microsoft TTS (en-US-AriaNeural), zero config
- [x] **Provider chain updates**: images.ts (FLUX→Grok→SVG), animate.ts (cinematic default), voiceover.ts (Edge-TTS first)
- [x] **Fixed critical bugs** from adversarial review: filter label regex, near-zero duration, Grok retry loop
- [x] **Updated docs**: README.md, ARCHITECTURE.md, CLAUDE.md, .env.example

### Verified (2026-07-05)
- `npm run typecheck` → **PASS** (0 errors)
- `npm test` → **6/6 unit tests PASS**
- End-to-end 3-scene pipeline → 1920×1080 H.264 clips with cinematic motion + particles + Edge-TTS narration

### Known limitation (confirmed 2026-07-19)
This approach produces **narrated storybook** style, NOT **talking characters**. Camera motion on static FLUX images is not sufficient for the target quality. See 2026-07-19 entry above.
