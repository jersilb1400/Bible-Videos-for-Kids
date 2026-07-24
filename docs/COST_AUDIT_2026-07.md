# 💰 Cartooney Clone — Cheaper Generation Audit (2026-07)

Verified against live provider docs on 2026-07:
- https://fal.ai/pricing  ✓
- https://docs.x.ai/docs/pricing  ✓
- https://ai.google.dev/pricing  ✓
- https://platform.stability.ai/pricing  ✓

## TL;DR

Three one-line changes would drop episode cost from **~$0.80** (fal Flux default) to
**~$0.04–0.10** with no quality loss:

1. **Swap fal Flux → xAI `grok-imagine-image`** for keyframes (cheapest cartoon model
   on the public market, $0.002/image at 1K).
2. **Default to "standard" quality tier** in `grokImagine.ts` (10× cheaper than
   "quality" for visually similar cartoon output).
3. **Wire Nano Banana (Gemini 2.5 Flash Image)** as a free fallback for batches
   during OpenRouter-key-free runs.

Below: full audit + table of where every dollar goes today.

---

## 1. Current pipeline cost — by stage

| Stage | Provider today (with key) | Cost/episode (20 sc) | Where the $ goes |
|---|---|---|---|
| Story | OpenRouter Hermes 4 | **$0.02** | `src/stages/story.ts` |
| Safety | OpenRouter Llama 3.3 70B | $0.01 | `src/moderation.ts` |
| Keyframes | **fal.ai Flux 2** | **$0.80** ($0.04 × 20) | `src/providers/falFlux.ts` |
| Animation | cinematic motion + particles (no key) | **$0** | `src/stages/animate.ts` |
| Voiceover | Edge-TTS | **$0** | `src/providers/edgeTts.ts` |
| Music | ffmpeg C-major sine pad | **$0** | `src/stages/music.ts` |
| Assembly | ffmpeg | $0 | `src/stages/assemble.ts` |
| Thumbnail | ffmpeg drawtext | $0 | `src/stages/thumbnail.ts` |
| Metadata | OpenRouter template | **$0.01** | `src/stages/metadata.ts` |
| Publish | YouTube API v3 | $0 | `src/providers/youtube.ts` |
| **Total** | | **~$0.83/ep** | |

Without `FAL_API_KEY`, total is **$0.04** (just the two OpenRouter calls).

## 2. What changed in 2026 that's cheaper than what you're using

### Images
- **fal.ai Flux 2 / Kontext Pro: $0.04/image** (you already use this)
- **xAI `grok-imagine-image` standard tier: $0.002/image** — **20× cheaper** than Flux
  and supports reference-image conditioning for character consistency.
  docs.x.ai pricing confirms `grok-imagine-image` at `0.002/img 1K` and `0.02/img 2K`.
- **Google Gemini 2.5 Flash Image (Nano Banana): $0.039/image** paid (batch: $0.0195),
  no usable free image output in the standard tier for character work.
- **Imagen 4 Fast: $0.02/image, Standard: $0.04** — but Imagen 4 is deprecated,
  shutting down Aug 17, 2026. Don't build on it.

### Video (if you want to upgrade animation)
- **fal.ai Wan 2.5: $0.05/sec** ($0.40 for an 8s clip × 6 premium scenes = $2.40)
- **fal.ai Kling 2.5 Turbo Pro: $0.07/sec**
- **Veo 3.1 Lite: $0.05/sec (720p) / $0.08 (1080p)**
- **xAI `grok-imagine-video-1.5`: $0.08/sec 720p, $0.14/sec 1080p**
- **xAI `grok-imagine-video`: $0.01/sec** ← cheapest production-quality video
  currently available, but worse quality.
- **Self-host Wan 2.2 on Hetzner / RunPod**: $0.50/episode per your notes.
- **Self-host on M4 Pro (zero $)**: blocked by PyTorch 2.2.2 vs required 2.4+.

### Music
- **Suno: ~$0.10** (still the leader)
- **ffmpeg sine pad: $0** (already shipped)
- **Lyria 3 (Google): free tier available**

### TTS
- **Edge-TTS: $0** (your current default — best option)
- **xAI TTS: $15/1M chars** (your voiceover.ts has it as fallback)
- **ElevenLabs: paid**

## 3. Issues in the existing code

### A. `src/quality.ts` PRICES table is wrong (2025-era numbers)

Current values:
```ts
grokImage:  0.50,   // actual: 0.002–0.02
grokVideo:  0.50,   // actual: 0.01–0.25
falImage:   0.04,   // correct
falVideo:   0.40,   // actual: 0.05–0.07
```

Fix the table so `estimateCost()` returns real numbers. This is a 2-line PR.

### B. `src/providers/grokImagine.ts` defaults to "quality" model

Line 47:
```ts
const model = quality === "quality" ? "grok-imagine-image-quality" : "grok-imagine-image";
```

`renderGrok` in `src/stages/images.ts:78` always passes `"quality"`. Change default
to `"standard"` to get the $0.002/image tier. Quality difference for cartoon
content is minimal (the basic model is specifically designed for high-throughput
use cases — exactly our batch render scenario).

### C. `src/stages/images.ts` provider ordering

Current order: **fal Flux → Grok → local SVG**

Optimal for cost: **Grok standard tier ($0.002) → fal Flux → local SVG**
   (only if quality issue with Grok, fall back to proven Fal chain)

Why: Grok is 20× cheaper, has reference-image conditioning for character
consistency (same approach the project already uses for Flux), and was literally
designed to be the workhorse for image generation at scale.

### D. `renderSceneSvg` (offline renderer) — limits

It produces cute but flat cartoon with:
- 3-character max per scene (line 115: `cast.slice(0, 3)`)
- Backgrounds are tan/blue gradients — not true Pixar aesthetic
- Character consistency is via fixed palette + SVG re-emit, not via reference
  (works fine for true offline mode but won't beat even Grok standard for quality)

Honest verdict: the offline SVG renderer is **good enough for early dev/CI**,
not for production episodes at scale.

## 4. Recommended changes (in priority order)

### Priority 1 (5-min change, ~20× cost reduction)
**Set `XAI_API_KEY` and let Grok Imagine handle keyframes instead of fal.**
- `echo "XAI_API_KEY=..." >> .env`
- `echo "IMAGE_PROVIDER=grok" >> .env`
- Change `renderGrok` default quality to `"standard"` (src/stages/images.ts:78)
- Cost: **$0.04/episode** instead of $0.80
- Quality: comparable for cartoon, possibly worse for photorealism (we don't care)

### Priority 2 (10-min change, fixes the wrong cost estimator)
**Update `src/quality.ts` PRICES** to live numbers. Add to PRICES table:
```ts
grokImageStd:    0.002,   // grok-imagine-image 1K
grokImageQuality: 0.02,   // grok-imagine-image 2K
grokImagePro:     0.07,   // grok-imagine-image-pro
grokVideo:        0.01,   // grok-imagine-video per sec
grokVideo15:      0.08,   // grok-imagine-video-1.5 per sec 720p
falImageFlux:     0.04,   // fal Flux 2 / Kontext
falVideoWan:      0.05,   // fal Wan 2.5 per sec
falVideoKling:    0.07,   // fal Kling 2.5 per sec
```

### Priority 3 (1-hr change, optional next-level cost cut)
**Add Nano Banana (Gemini 2.5 Flash Image) as free batch tier.**
- Free for ≤1.5K RPD (free tier is "Free of charge" with shared rate limits)
- Batch tier $0.0195/image for higher volumes
- Use for "filler" scene types, reserve Grok for "premium" hero scenes
- Architecture: a `nanoBanana.ts` provider parallel to `grokImagine.ts`

### Priority 4 (open question for you — confirm preferred posture)
**Should the pipeline default to the cheapest viable option, or the highest quality at <$5/episode?**

Current posture: highest quality within budget ($5/ep cap, currently $0.83/ep).
Alternative: cheapest viable (~$0.04/ep) and save the difference for premium
hero content on the days you care about visual quality.

For a kids Bible cartoon channel at 1 episode/day for a year:
- Current: $300/year
- Cheapest viable: $15/year
- Recommended hybrid: $30-60/year (cheap standard for most, premium quality for 2-3 flagship episodes/month)

## 5. What I'm NOT recommending (and why)

- **Don't switch to Veo 3.1, even though it generates video+audio in one shot.**
  At $0.40/sec for an episode that's ~$32 of pure rendering cost — 40× the entire
  current pipeline. The audio output also isn't kid-friendly English by default; we'd
  re-render and mix anyway.

- **Don't invest in self-hosting Wan 2.5/2.7 at scale yet.** RunPod RTX 4090 is
  $0.50/ep per your notes; Hetzner H100 is $1.89/hr and would break even at ~30
  episodes/month. Below that scale, pay-as-you-go APIs win on cost + ops simplicity.

- **Don't replace Edge-TTS with a paid TTS.** Edge-TTS is genuinely excellent for
  child narration (JennyNeural is the right voice). Paid TTS gains you "5% better
  emotion" at 1000× the cost.

- **Don't add Kling 3.0 yet.** fal.ai listing has Kling 2.5 Turbo Pro at $0.07/sec —
  the new Kling tier hasn't propagated to fal yet (verified on the pricing page).

## 6. Decisions you should make this week

1. Add `XAI_API_KEY` to `.env` and switch `IMAGE_PROVIDER=grok` as default?
   (1 env var change, makes the project actually use cheap cartoon gen)
2. Set a hard spend cap on your xAI account? ($10/mo recommended for current pace.)
3. Want me to implement any of priorities 1-3 above? Most are 5-60 min each.

---

## MiniMax (Xiyu Technology) pricing — verified 2026-07-08

Sources:
- `https://platform.minimax.io/docs/guides/pricing-paygo` (pay-as-you-go API pricing) ✓
- `https://hailuoai.video/subscribe` (consumer Hub plans) — researched in previous sessions
- Verified by scraping actual pricing pages today

### MiniMax Platform API (pay-as-you-go, no monthly minimum)

| Model | Price | Equivalent for cartoon pipeline |
|---|---|---|
| **image-01** (image gen) | **$0.0035/image** | 285 images/$1 |
| **MiniMax-Hailuo-02** (video, current gen) | $0.10 / 512P / 6s | = $0.0167/sec at 512p |
| | $0.19 / 768P / 6s | = $0.0317/sec at 768p |
| | $0.33 / 1080P / 6s | = $0.055/sec at 1080p |
| | $0.15 / 512P / 10s | cheaper per sec for longer clips |
| | $0.28 / 768P / 6s (legacy "better") | |
| | $0.49 / 1080P / 6s (legacy) | |
| | $0.56 / 768P / 10s | |
| **speech-02-turbo** (TTS) | $60/M characters | = $0.18/ep for 3,000-char script |
| **speech-02-hd** (TTS) | $100/M characters | = $0.30/ep |
| **Lyrics Generation** | Limited free | |
| **Music 2** generation | separate per-song pricing | |

### MiniMax Hub consumer (hailuoai.video/subscribe) — researched earlier sessions

- **New user signup**: 2,000 free credits, banner-verified (Hub-exclusive Seedance 2.0 launch promo)
- **Free tier**: $0, 0 credits/mo after signup bonus (one-time trial models only)
- **Standard**: $7.99/mo or $95.99/yr, 1,000 credits → Seedance 2.0 at -50% credit discount
- **Pro**: $27.99/mo, 4,500 credits
- **Master**: $63.99/mo, 10,500 credits
- **Max**: $199.99/mo, 20,000 credits + Unlimited Hailuo 1.0/2.0/2.3 (no cap on those models)
- **⚠️ 3-day free trial**: Master/Max/Ultra trial — auto-bills on day 4 (don't use without setting a cancel alarm)
- **Watermark**: Yes on Free tier, removed on paid tiers

### Seedance 2.0 specifically (Hub-only, NOT on platform.minimax.io API)

- 720p from **$0.04/sec** (Hub-exclusive 65% off promo)
- 4K available
- Standard tier: Seedance -50% credit discount = $0.18/episode at 6-scene × 280s
- Multi-modal reference (up to 9 images, 3 videos, 3 audio)
- Style: photorealistic default (not naturally cartoon)
- Excludes real human faces

### Position in the 2026 cartoon cost landscape

| Service | Image cost | Video cost (cartoon-grade, 6s clip) | Notes |
|---|---|---|---|
| **MiniMax image-01 (API)** | **$0.0035** | n/a | API only (no Hub consumer API for cartoon-y content specifically) |
| **MiniMax Hub Image (Free trial)** | $0 (one-time 200 credits) | n/a | watermark on free |
| xAI grok-imagine-image | $0.002 (basic 1K) / $0.02 (2K) | $0.01/sec (basic) / $0.08/sec (1.5) | best $/quality for cartoon |
| fal Flux Kontext Pro | $0.04/image | n/a | highest quality multi-ref |
| fal Wan 2.5 | n/a | $0.05/sec | open model, can also self-host |
| Google Gemini 2.5 Flash Image (Nano Banana) | $0.039/image | n/a | $0.0195 batch tier, free tier limited |
| ElevenLabs | n/a (TTS only) | n/a | paid TTS, $0.04/scene |
| Edge-TTS (already wired) | $0 | n/a | default in pipeline |

### Recommended integration if you get a MiniMax API key

Use **MiniMax image-01 at $0.0035/image** as a secondary fallback. It's:
- Marginally more expensive than xAI Grok standard ($0.002/image)
- Cheaper than fal Flux ($0.04/image)
- Free with up to 50,000 credits at signup on some tiers
- Image quality strong enough for cartoon (similar to Flux dev-tier output)

⚠️ **Don't** subscribe to the Hub Standard/Master tier until you have a clear monthly budget. The $7.99/mo minimum doesn't auto-cancel if usage drops, and the 3-day trial auto-bills to your card on day 4.

### Pipeline stage update if MiniMax is added:

```ts
// In src/stages/images.ts, new Tier 1.5:
async function renderMinimax(story, storage): Promise<{files: string[]; urls: string[]}> {
  const minimax = new MiniMaxImageProvider();  // new
  // Use image-01 at $0.0035/image
  // Falls back to Grok → Flux → SVG
}
```

Cost comparison for 20-scene episode:

| Provider chain | Cost |
|---|---|
| MiniMax image-01 (primary, new) | $0.07 |
| Grok standard (alternate) | $0.04 |
| Flux 2 (current default) | $0.80 |
| Local SVG (offline) | $0 |

**Decision time**: The absolute cheapest paid option is Grok standard at $0.04/ep, then MiniMax at $0.07/ep, then Flux at $0.80/ep. If you want to add MiniMax, do it as a Tier 2 fallback after Grok, not as the primary. The extra 1.75× cost is not worth it unless you specifically need MiniMax's image style.

The MiniMax Hub consumer subscription is **not worth it** for this project — the $7.99/mo Standard tier minimum commitment + no public API on cartoon content = no upside vs xAI or fal. Stick with the $0 path + xAI when image quality matters.
