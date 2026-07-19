# CLAUDE.md — Bible Videos for Kids

This file gives Claude Code (and other AI agents) everything needed to work in this repo without reading every source file first.

---

## What this project is

**Bible Videos for Kids** is a fully autonomous pipeline that:
1. Writes a children's Bible story (via LLM)
2. Renders it as a cute cartoon animated video — consistent characters, narration, music, burned captions
3. Publishes it to YouTube — on a schedule, unattended

The defining design choice: **every stage has an offline fallback**. The whole pipeline runs end-to-end with **zero API keys** and produces a real `episode.mp4`. Flip stages to production providers one env var at a time.

Target audience: children ages 3–8. Content must be gentle, joyful, and safe for kids.

### Current direction (as of 2026-07-19)

**Pivoting from narrated storybook → talking characters with lip-sync.** Reference: Minno "Laugh and Grow Bible" (2D animated, character dialogue, lip-sync, proper music). The current FLUX + cinematic camera motion pipeline produces quality images but no character animation or lip-sync. See `PROGRESS.md` for full evaluation of Higgsfield MCP, Kling.ai MCP, and ComfyUI self-hosted paths.

**Provider tiers (planned):**
- **Tier 0 (offline fallback):** SVG + ffmpeg cinematic (current, $0)
- **Tier 1 (current production):** fal FLUX images + local cinematic ($0.50-3/ep)
- **Tier 2 (no-GPU talking characters):** Higgsfield MCP or Kling.ai MCP (~$20-50/ep)
- **Tier 3 (cost optimization):** ComfyUI self-hosted on Hetzner/RunPod (~$0.18/ep)

**Kling.ai MCP** (`https://kling.ai/mcp`) — official MCP, per-second billing ($0.042-$0.14/s), native lip sync ($0.07/5s), TTS ($0.035/call), Avatar. Bonus credits NOT usable on MCP — must buy paid credits.

**Higgsfield MCP** (`bridge.higgsfield.ai`) — already integrated in `src/providers/higgsField.ts`. Starter plan (320 free credits) works for images. Video needs Pro. Soul ID for character consistency. `sync_lipsync_3` for lip sync.

---

## Quick-start (Cloudflare + Hetzner production)

```bash
make deploy          # install Wrangler + apply D1 schema + deploy Worker
make secrets         # interactive: set all API keys via wrangler secret put
make topics          # insert 60 Bible story topics into D1
make monitor         # view episode status, queue, render service health
make run             # trigger one episode manually (set WORKER_URL first)
make typecheck       # TypeScript check (worker + render service)
```

**Prerequisites:** Node ≥ 20, Bun, `wrangler` (installed by `make deploy`).

### Local offline pipeline (no keys needed)

```bash
npm install
npm run run -- --topic "Noah's Ark"          # full offline run → episode.mp4
npm run typecheck && npm test
```

**Hard requirements:** Node ≥ 20 and `ffmpeg`/`ffprobe` on `PATH`. No build step — runs via `tsx`.

---

## Environment configuration

Copy `.env.example` to `.env`. Every key is optional — missing keys silently fall back to the offline implementation.

| Variable | Stage | Default |
|----------|-------|---------|
| `OPENROUTER_API_KEY` | story, metadata, safety | offline built-in story |
| `OPENROUTER_MODEL` | story | `nousresearch/hermes-4-405b` |
| `OPENROUTER_UTILITY_MODEL` | metadata, safety | `meta-llama/llama-3.3-70b-instruct` |
| `IMAGE_PROVIDER` | keyframes | `fal` (FLUX 2 via fal.ai) |
| `FAL_API_KEY` | keyframes, animation | — |
| `FAL_IMAGE_MODEL` | keyframes | `fal-ai/flux-2` |
| `FAL_VIDEO_MODEL` | animation | `fal-ai/pixverse/v4.5/image-to-video` |
| `HIGGSFIELD_API_KEY` | keyframes (Tier 2) | — |
| `HIGGSFIELD_BASE_URL` | keyframes (Tier 2) | `http://127.0.0.1:48956` (Bridge) |
| `KLING_API_KEY` | video, lip sync, TTS (planned) | — |
| `VIDEO_PROVIDER` | animation | `local` (cinematic ffmpeg) |
| `TTS_PROVIDER` | voiceover | `edge-tts` (free, zero-config) |
| `ELEVENLABS_API_KEY` | voiceover | — |
| `ELEVENLABS_VOICE_ID` | voiceover | — |
| `KOKORO_ENDPOINT` | voiceover | — |
| `MUSIC_PROVIDER` | music | `local` (ffmpeg C-major pad) |
| `SUNO_API_KEY` | music | — |
| `PUBLISH_PROVIDER` | publish | `mock` (writes manifest, no upload) |
| `YOUTUBE_CLIENT_ID` | publish | — |
| `YOUTUBE_CLIENT_SECRET` | publish | — |
| `YOUTUBE_REFRESH_TOKEN` | publish | — |
| `YOUTUBE_PRIVACY` | publish | `unlisted` |
| `REQUIRE_APPROVAL` | publish gate | `false` |
| `OUTPUT_DIR` | all | `./out` |
| `VIDEO_WIDTH` / `VIDEO_HEIGHT` | all | `1920` / `1080` |

---

## Pipeline — 9 stages in order

```
1. story      →  2. safety  →  3. voiceover  →  4. images  →  5. animate
→  6. lipsync (planned)  →  7. music  →  8. assemble →  9. thumbnail  →  10. metadata  →  publish
```

**Critical ordering invariant:** voiceover runs *before* animation. Real TTS clip lengths are probed with `ffprobe` and become each scene's duration, so animation and burned captions line up exactly with the spoken narration. Do not reorder these two stages.

**Planned: Stage 6 (lipsync)** — between animation and assembly. Takes animated clip + character TTS audio → syncs character mouth to dialogue. Providers: Kling native lip sync API ($0.07/5s) or Higgsfield `sync_lipsync_3`.

| # | Stage | File | Offline | Production |
|---|-------|------|---------|------------|
| 1 | Story + script | `src/stages/story.ts` | built-in Daniel story | OpenRouter Hermes |
| 2 | Kids-safety gate | `src/moderation.ts` | keyword blocklist | OpenRouter utility model |
| 3 | Voiceover (TTS) | `src/stages/voiceover.ts` | **Edge-TTS** (free) | ElevenLabs or Kokoro |
| 4 | Keyframes (images) | `src/stages/images.ts` | SVG → PNG via resvg | fal Flux 2 / Higgsfield / ComfyUI |
| 5 | Animation (img→video) | `src/stages/animate.ts` | **FFmpeg cinematic motion + particles** | Higgsfield / Kling.ai / Wan 2.1 |
| 6 | Lip Sync (planned) | `src/stages/lipsync.ts` (todo) | skip | Kling native / Higgsfield `sync_lipsync_3` |
| 7 | Music bed | `src/stages/music.ts` | ffmpeg sine-wave pad | Suno |
| 8 | Assembly | `src/stages/assemble.ts` | ffmpeg (captions + mux) | same ffmpeg on Hetzner |
| 9 | Thumbnail | `src/stages/thumbnail.ts` | ffmpeg title card | — |
| 10 | SEO Metadata | `src/stages/metadata.ts` | template | OpenRouter utility model |
| — | Publish | `src/stages/publish.ts` | writes manifest JSON | YouTube Data API v3 |

---

## Data model (`src/types.ts`)

All schemas are validated with **zod** — never trust raw LLM JSON.

```
Story
  title       string
  source      string        (Bible passage, e.g. "Daniel 6")
  lesson       string        (one-line moral for parents)
  characters  Character[]   (min 1, reused across scenes)
  scenes      Scene[]       (min 3, recommended 5–7)

Character
  name        string
  description string        (stable look — appended to every scene prompt)
  palette     { skin, hair, robe }  (hex — locks color across offline renders)

Scene
  narration   string        (1–2 short sentences, simple words)
  dialogue    Dialogue[]     (PLANNED — speaker, line, emotion — for talking characters)
  visual      string        (image/animation prompt)
  characters  string[]      (names present in this scene)
  setting     day|night|sunrise|indoor|water|desert

Dialogue (PLANNED — not yet in zod schema)
  speaker     string        (character name)
  line        string        (what they say)
  emotion     string        (happy|sad|afraid|brave|wonder|calm)

Production   (artifact bundle threaded through all stages)
  id, story, sceneImages[], sceneClips[],
  narrationAudio, musicAudio, finalVideo, thumbnail,
  metadata, sceneDurations[], publishResult
```

**Character consistency mechanism:** each character's `description` and `palette` are injected into every scene prompt. The offline SVG renderer locks colors by palette. Production image models (Flux 2 multi-ref, Higgsfield Soul ID, Kling reference image) use the description for identity lock-in across the episode.

**Planned: Dialogue support** — the `Scene` schema needs `dialogue[]` to support talking characters (reference: Minno "Laugh and Grow Bible"). This requires: (1) zod schema update, (2) story generator rewrite for character dialogue, (3) per-character TTS with different voices, (4) lip-sync stage to sync character mouths to dialogue audio.

---

## File structure

```
bible-story-studio/          ← repo root when deployed to Bible-Videos-for-Kids
├── src/
│   ├── index.ts             CLI entry (run, --topic, --no-publish)
│   ├── pipeline.ts          Orchestrator — 9-stage order + approval gate
│   ├── config.ts            Centralised env config + .env loader (no dotenv dep)
│   ├── storage.ts           Local FS storage; swap body for Cloudflare R2 in prod
│   ├── moderation.ts        Kids-safety gate (keyword + optional LLM classifier)
│   ├── logger.ts            Structured console logger (log.stage/info/ok/warn)
│   ├── types.ts             Zod schemas: Scene / Character / Story / Production
│   ├── stages/
│   │   ├── story.ts         LLM story generation (offline: built-in Daniel story)
│   │   ├── voiceover.ts     TTS per scene + ffprobe duration measurement
│   │   ├── images.ts        Keyframe rendering (offline: SVG via resvg)
│   │   ├── animate.ts       Image → video clip (offline: cinematic camera motion + particles)
│   │   ├── music.ts         Background music bed (offline: ffmpeg sine pad)
│   │   ├── assemble.ts      Final mux: captions + audio concat + music mix
│   │   ├── thumbnail.ts     1280×720 thumbnail from first keyframe
│   │   ├── metadata.ts      YouTube SEO title/description/tags
│   │   ├── stockAssembly.ts Stitch pre-existing stock clips + narration + music
│   │   └── publish.ts       YouTube upload or mock manifest
│   └── providers/
│       ├── openrouter.ts    Minimal OpenRouter/OpenAI-compatible chat client
│       ├── svgScene.ts      Deterministic flat-vector cartoon SVG renderer
│       ├── ffmpeg.ts        ffmpeg/ffprobe helpers + caption escaping utilities
│       ├── youtube.ts       YouTube Data API v3 resumable upload (fetch-only)
│       ├── falFlux.ts       fal.ai FLUX 2 image generation (keyframes)
│       ├── higgsField.ts    Higgsfield MCP image generation (Tier 2, Bridge)
│       ├── edgeTts.ts       Microsoft Edge-TTS (free, zero-config)
│       ├── cameraMotion.ts  FFmpeg zoompan filters (zoom/pan/drift)
│       ├── particles.ts     Particle overlays (sparkles/fireflies/stars/sunbeams)
│       └── promptBuilder.ts Pixar-style cartoon prompt templates
├── cloudflare/
│   ├── worker.ts            Full Workflows control plane (all 11 steps, approval gate)
│   ├── wrangler.jsonc       Wrangler config: Workflow, R2, D1, Cron Trigger
│   ├── schema.sql           D1 schema + 20 seed topics (idempotent, safe to re-run)
│   ├── package.json         Wrangler + @cloudflare/workers-types
│   └── tsconfig.json        Worker TypeScript config
├── render-service/
│   ├── server.ts            Hono HTTP server (port 3001, graceful SIGTERM)
│   ├── assemble.ts          Core ffmpeg assembly: captions + mux + music + thumbnail
│   ├── r2.ts                S3-compatible R2 download/upload helpers
│   ├── ffmpeg.ts            ffmpeg/ffprobe spawn helpers + caption wrap
│   ├── types.ts             AssembleRequest / AssembleResult interfaces
│   ├── package.json         hono + @aws-sdk/client-s3
│   ├── tsconfig.json        Bun-compatible TypeScript config
│   ├── ecosystem.config.cjs PM2 config (name: bible-render)
│   ├── .env.example         Port, RENDER_TOKEN, R2 credentials
│   └── setup.sh             One-shot Hetzner Ubuntu setup (ffmpeg, Bun, PM2)
├── scripts/
│   ├── deploy.sh            One-shot deploy (schema + worker)
│   ├── secrets.sh           Interactive wrangler secret put for all keys
│   ├── youtube-oauth.ts     OAuth2 refresh token helper (Bun)
│   ├── setup-tunnel.sh      Cloudflare Tunnel setup for Hetzner
│   ├── monitor.sh           Episode status + queue + render health
│   └── add-topics.ts        Bulk topic insertion (60 curated stories)
├── .github/
│   └── workflows/deploy.yml Auto-deploy Worker on push to main
├── Makefile                 Developer shortcuts (deploy, secrets, monitor, run, topics)
├── test/
│   └── pipeline.test.ts     Unit tests + full offline end-to-end run → mp4
├── .env.example             All env vars with explanations
├── package.json
├── tsconfig.json
├── ARCHITECTURE.md          Full design doc, cost notes, tool selection rationale
└── CLAUDE.md                ← this file
```

**Output** (written to `out/<YYYY-MM-DD>-<shortid>/`, gitignored):
```
episode.mp4          finished 1080p video
thumbnail.jpg        YouTube thumbnail
images/              per-scene PNG keyframes
clips/               per-scene animated .mp4 clips
audio/               per-scene narration + music bed
segments/            captioned+narrated segment clips
upload-manifest.json what would be sent to YouTube (mock mode)
```

---

## Conventions — must follow

- **ESM + NodeNext:** all imports use explicit `.js` extensions on `.ts` source files (e.g. `import { config } from "./config.js"`). This is required for `tsx` and `tsc` to work correctly.
- **TypeScript strict** — `npm run typecheck` must pass before claiming done.
- **Validate all LLM/external output with zod** — `StorySchema.parse(...)`, never trust raw JSON from a model.
- **Read env via `config` object only** — never call `process.env` directly in stage files; add a field to `src/config.ts` and consume it there.
- **Spend money late** — text stages (story, safety) always run before media stages. The safety gate aborts the pipeline before any render cost.
- **Every new provider keeps an offline fallback** — tests and demos must run free and deterministically with no keys.
- **No comments explaining what** — only add a comment when the *why* is non-obvious (a constraint, a workaround, an invariant).

---

## Extending the pipeline

**New stage:**
1. Create `src/stages/<name>.ts` exporting `async function <name>(... Production fields ..., storage: Storage): Promise<...>`
2. Import and call it from `src/pipeline.ts` in the correct position (mind the voiceover → animate duration dependency)

**New provider:**
1. Add `src/providers/<name>.ts`
2. Branch on `config.<stage>.provider` inside the relevant stage file
3. Keep the existing `local`/`mock` path as the default fallback

**Series memory (planned):** persist character sheets + "stories already told" list in R2/D1 so the cron picks fresh topics and reuses characters across episodes.

---

## Stock clip assembly

For episodes that incorporate licensed/downloaded 3D footage (e.g. Noah's Ark clips):

```bash
# 1. Write a manifest JSON describing the clips and their narration
cp scripts/stock-manifest.example.json my-manifest.json
# edit my-manifest.json — set clipsDir, title, voice, and clip order

# 2. Run the stock assembly stage
npm run stock -- --manifest my-manifest.json

# 3. Find the output
# out/<date>-<slug>/episode.mp4
```

The manifest schema validates with zod (`StockManifestSchema`). Key features:
- **Auto-dedupe**: byte-identical clips are skipped (just list everything; the tool finds the 3 unique ones)
- **Narration fits clip**: narration is trimmed/padded to the clip's fixed duration (opposite of the main pipeline where clip duration follows narration)
- **Reuses existing pipeline primitives**: edge-tts TTS, C-major music bed, caption burning (if drawtext available)
- **Scales to 1920×1080** with letterboxing automatically

---

## Cloudflare + Hetzner production deployment

```
Cloudflare Cron (0 15 * * *) → StudioWorkflow (durable, checkpointed)
  step 0:  pick topic         → D1 topics_queue
  step 1:  story              → OpenRouter Nous Hermes 4 405B
  step 2:  safety gate        → keyword blocklist + Llama 3.3 70B
  step 3:  keyframes          → fal.ai Flux 2  (character-consistent)
  step 4:  animate            → **fal.ai PixVerse V4.5 (premium scenes only) / cinematic ffmpeg (default)**
  step 5:  voiceover          → **Edge-TTS (default) / ElevenLabs Rachel (11_multilingual_v2)**
  step 6:  music              → Suno API  (instrumental)
  step 7:  assemble           → Hetzner render service  (ffmpeg, can't run in Worker)
  step 8:  SEO metadata       → Llama 3.3 70B
  step 9:  record to D1       → series memory + character library
  step 10: publish            → YouTube Data API v3  (or hold if REQUIRE_APPROVAL=true)
```

### First-time setup

```bash
# 1. Deploy the Worker
make deploy

# 2. Set all secrets
make secrets

# 3. Seed Bible story topics
make topics

# 4. Provision Hetzner server (CX21 or higher)
#    SSH into the box, clone this repo, then:
bash render-service/setup.sh
# Fill in render-service/.env, then:
pm2 start render-service/ecosystem.config.cjs && pm2 save && pm2 startup

# 5. Expose render service via Cloudflare Tunnel
bash scripts/setup-tunnel.sh  # run on Hetzner box

# 6. Get YouTube refresh token (run on your laptop)
make youtube-oauth YOUTUBE_CLIENT_ID=xxx YOUTUBE_CLIENT_SECRET=yyy

# 7. Monitor
make monitor
```

### Wrangler secrets reference

| Secret | Source |
|--------|--------|
| `OPENROUTER_API_KEY` | openrouter.ai → Keys |
| `FAL_API_KEY` | fal.ai → API Keys |
| `ELEVENLABS_API_KEY` | elevenlabs.io → Profile → API Keys |
| `SUNO_API_KEY` | suno.ai → Settings |
| `RENDER_TOKEN` | any strong random string (same in render-service/.env) |
| `RENDER_ENDPOINT` | your tunnel hostname, e.g. `https://render.yourdomain.com` |
| `YOUTUBE_CLIENT_ID` | Google Cloud Console → Desktop app credential |
| `YOUTUBE_CLIENT_SECRET` | same credential |
| `YOUTUBE_REFRESH_TOKEN` | run `make youtube-oauth` |
| `REQUIRE_APPROVAL` | optional — set `true` to hold before publish |

### R2 API token (for render service)

Cloudflare Dashboard → R2 → Manage R2 API Tokens → Create Token (read + write on `bible-story-artifacts`). Put values in `render-service/.env`.

### CI/CD — auto-deploy on push

`.github/workflows/deploy.yml` deploys the Worker whenever `cloudflare/` changes on `main`.  
Add `CLOUDFLARE_API_TOKEN` as a GitHub repository secret (Cloudflare Dashboard → User API Tokens → "Edit Cloudflare Workers" template).

---

## Safety & compliance — never regress

- **Safety gate runs before any paid render.** Keep it that way.
- **Uploads default to `unlisted` + `selfDeclaredMadeForKids: true`.** Only flip to `public` after human review.
- **`REQUIRE_APPROVAL=true`** halts the pipeline before publish for manual sign-off.
- **Keyword blocklist** in `src/moderation.ts` is a hard backstop — the LLM classifier is an additional layer, not a replacement.
- Use original, gentle retellings — verbatim Bible verse quotes may trigger copyright issues.
- Review the channel against YouTube's COPPA / "Made for Kids" requirements before going public at scale.

---

## Scripts reference

| Script | What it does |
|--------|-------------|
| `scripts/deploy.sh` | `npm install` → `wrangler d1 execute schema.sql` → `wrangler deploy` |
| `scripts/secrets.sh` | Interactive prompts → `wrangler secret put` for each key |
| `scripts/youtube-oauth.ts` | Local OAuth2 server → exchanges code → prints refresh token |
| `scripts/setup-tunnel.sh` | Installs cloudflared + registers as system service on Hetzner |
| `scripts/monitor.sh` | D1 recent episodes + queue stats + render service health |
| `scripts/add-topics.ts` | Inserts 60 curated Bible topics into D1 (`--preview` to list first) |

---

## Gotchas

- `ffmpeg` and `ffprobe` must be on `PATH` on the Hetzner box. `render-service/setup.sh` installs them via apt.
- `ffmpeg` cannot run inside a Cloudflare Worker — that is why `render-service/` exists as a separate Hetzner HTTP service.
- Approval mode: set `REQUIRE_APPROVAL=true` as a Wrangler secret. Episodes stop at status `awaiting_approval`. Publish with `POST /approve/:id` (Bearer `RENDER_TOKEN`).
- Imports in `src/` must end in `.js` even though source files are `.ts`. ESM/NodeNext requirement — do not remove extensions.
- `out/`, `.env`, `node_modules/`, and `*.log` are gitignored. Never commit them.
- The Cloudflare Tunnel must be running on Hetzner before the daily cron fires, otherwise step 7 (assemble) will fail and retry.

---

## Agentic Loop Contract

**Verification command** (local development):
```bash
npm run typecheck && npm test
```
Work is **not done** until this check passes. Paste the check output, not assertions.

**Deployment verification** (production changes):
```bash
make typecheck && make deploy && make health-check
```
Add `REQUIRE_APPROVAL=true` before any publish-stage change.

**Two-correction rule:** if the same issue is corrected twice, stop, record the lesson, and recommend a fresh session with a better prompt. A clean session beats a long one with accumulated corrections.

**End-of-session learning pass:** before finishing any session, append repeatable lessons below as short imperative rules, delete rules proven unnecessary, and update PROGRESS.md with completed items, failed approaches with why, and the exact next step.

**Model routing:**
- Orchestrator / feature work: `claude-sonnet-4-6` — scoped subtask, bounded scope
- Adversarial reviewer (`.claude/agents/reviewer.md`): `claude-sonnet-4-6` — judgment work, never below worker tier
- Mechanical transforms (file renames, config edits): `claude-haiku-4-5`

**Budget:**
- Max iterations per feature item: 5
- Token budget: 20K per session
- On budget exhaustion: record state in PROGRESS.md and stop cleanly.

**Permissions:** see `.claude/settings.json`. The allow list grants safe operations; the deny list blocks irreversible and external actions. When unsure, default to deny.

**Stop condition:** all items in PROGRESS.md checked off with verification passing, OR a blocking issue is recorded and the loop is paused for human input. Never stop because "it looks done."
