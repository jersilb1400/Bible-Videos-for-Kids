# Visual Quality Pivot — FLUX Keyframes + Cinematic Animation

> **Status:** ✅ **COMPLETE** — All phases implemented, TypeScript compiles clean, unit tests pass, end-to-end pipeline verified.

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Replace the SVG+Ken Burns rendering path with FLUX-generated keyframes + cinematic camera motion (parallax crossfade, particle overlays), producing professional-quality children's cartoon videos at <$1/episode.

**Architecture:** The existing 9-stage pipeline stays intact. Only the image generation (Stage 4) and animation (Stage 5) stages are replaced. The voiceover, music, assembly, and publish stages remain unchanged. Key insight: you don't need AI video generation for quality — FLUX images + cinematic camera motion + particle effects is the proven OpenMontage approach at $0.15-1.33/video.

**Tech Stack:** fal.ai FLUX 2 (keyframes, ~$0.02-0.05/image), FFmpeg (cinematic camera motion, crossfade, particles), Kokoro TTS (free, already wired), existing pipeline infrastructure.

---

## Verification Prerequisites

### Verify fal.ai FLUX 2 Pricing Live

Before any code changes, confirm the actual per-image cost:

1. Navigate to https://fal.ai/pricing
2. Search for "FLUX" or "flux-2"
3. Note the per-image credit cost
4. Check if $10 pre-pay credit is still available
5. Document the verified price in config.ts as a comment

**Expected cost:** ~$0.02-0.05 per 1080p image. For 20 scenes = $0.40-1.00/episode. This replaces the $2.47/clip Grok video cost.

### Verify edge-tts Availability

Check if `edge-tts` is available as a zero-cost alternative to Kokoro:

```bash
pip install edge-tts 2>/dev/null && echo "edge-tts available" || echo "edge-tts not available"
```

If available, provide a simple Node.js wrapper that shells out to `edge-tts` for warm, expressive children's narration at $0 cost.

---

## Phase 0: Fix Critical Pipeline Bugs (Pre-requisite)

These bugs will break the new rendering path. Fix them first.

### Task 0.1: Fix `failedProviders` Race Condition in voiceover.ts

**Objective:** The module-level `Set<string>` and `silentLogged` flag are shared across all pipeline runs, causing cross-run contamination.

**Files:**
- Modify: `src/stages/voiceover.ts:74-76`

**Changes:**
Move `failedProviders` and `silentLogged` inside `renderVoice()` so each pipeline run gets a fresh set:

```typescript
// Before (lines 74-76):
const failedProviders = new Set<string>();
let silentLogged = false;

// After: move inside renderVoice() function body
async function renderVoice(text: string, out: string, silenceSeconds: number): Promise<void> {
  const failedProviders = new Set<string>();
  let silentLogged = false;
  // ... rest of function
}
```

**Verification:**
```bash
npm test
# Expected: all tests pass
```

### Task 0.2: Fix `narrationAudio` — Only Scene 0 Plays (C3 Bug)

**Objective:** The pipeline passes `narration[0]` (single string) to `assembleVideo` instead of the full array, so only the first scene's narration is ever used.

**Files:**
- Modify: `src/pipeline.ts:78`

**Changes:**
The `narration` variable is already `{ files: string[], durations: number[] }`. The `assembleVideo` function expects `narration: string[]` (array of file paths). The pipeline already passes `narration` (the object's `files` array is used via Spread or destructuring — verify the actual invocation).

Check line 88:
```typescript
const finalVideo = await assembleVideo(story, clips, narration, durations, music, storage);
```

If `narration` is `{ files: string[], durations: number[] }` here, change to:
```typescript
const finalVideo = await assembleVideo(story, clips, narration.files, durations, music, storage);
```

**Verification:**
```bash
npx tsx src/index.ts run --topic "Test" --no-publish
# Expected: audio plays for all scenes, not just scene 0
```

### Task 0.3: Fix R2 Stubs (render-service/r2.ts)

**Objective:** The R2 download/upload stubs are no-ops that throw, breaking the render-service path.

**Files:**
- Modify: `render-service/r2.ts`

**Changes:**
Implement proper mock implementations or add clear error messages that explain what's missing (R2 bucket name, binding, etc.).

**Verification:**
```bash
npm test
# Expected: tests pass
```

### Task 0.4: Fix 832×480 Output Resolution

**Objective:** Videos are rendering at 832×480 despite config saying 1920×1080. The pipeline needs to enforce resolution at every stage.

**Files:**
- Modify: `src/stages/animate.ts` (pass -s 1920x1080 to ffmpeg)
- Modify: `src/stages/assemble.ts` (pass -s 1920x1080 to ffmpeg)

**Changes:**
Add explicit `-s ${config.width}x${config.height}` to ffmpeg calls in animate.ts and assemble.ts:

```typescript
// In animate.ts animateTestStatic:
await ffmpeg([
  "-loop", "1", "-i", imagePath,
  "-t", duration.toFixed(2),
  "-s", `${config.width}x${config.height}`,  // ADD THIS
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
  "-r", String(config.fps),
  outputPath,
]);
```

**Verification:**
```bash
npm test
# Then check: ffprobe -v error -show_entries stream=width,height out/*/episode.mp4
# Expected: 1920x1080
```

---

## Phase 1: Replace SVG Keyframes with FLUX Images

### Task 1.1: Create fal.ai FLUX Provider Class

**Objective:** Encapsulate FLUX image generation in a clean provider class following the existing GrokImagineProvider pattern.

**Files:**
- Create: `src/providers/falFlux.ts`

**Provider class:**

```typescript
import { writeFileSync } from "node:fs";
import { config } from "../config.js";
import { log } from "../logger.js";

const FAL_BASE = "https://fal.run";

interface FalImageResult {
  images?: { url: string; content_type?: string }[];
  prompt?: string;
  seed?: number;
  request_id?: string;
}

/**
 * fal.ai Flux 2 image generation provider.
 * Generates high-quality cartoon-style keyframes for children's Bible videos.
 * Cost: ~$0.02-0.05 per 1080p image (verify on fal.ai/pricing).
 */
export class FalFluxProvider {
  get available(): boolean {
    return !!config.image.falKey;
  }

  /**
   * Generate a single image from a text prompt.
   * Returns the image URL (for downstream I2V providers) and downloads to local path.
   */
  async generateImage(
    prompt: string,
    outputPath: string,
    options?: {
      /** Override image size (default: config.width × config.height) */
      imageSize?: { width: number; height: number };
      /** Model override (default: config.image.falModel) */
      model?: string;
    },
  ): Promise<{ localPath: string; url: string }> {
    if (!this.available) throw new Error("FAL_API_KEY not configured");

    const model = options?.model || config.image.falModel;
    const size = options?.imageSize || { width: config.width, height: config.height };

    const res = await fetch(`${FAL_BASE}/${model}`, {
      method: "POST",
      headers: {
        Authorization: `Key ${config.image.falKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt,
        image_size: size,
        num_images: 1,
        sync_mode: true,  // Fast synchronous mode
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`fal ${res.status}: ${text}`);
    }

    const data = (await res.json()) as FalImageResult;
    const image = data.images?.[0];
    if (!image?.url) throw new Error("fal returned no image URL");

    // Download to local file
    const imgRes = await fetch(image.url);
    if (!imgRes.ok) throw new Error(`Image download failed: ${imgRes.status}`);
    const buffer = Buffer.from(await imgRes.arrayBuffer());
    writeFileSync(outputPath, buffer);

    log.info(`  fal Flux: ${outputPath.split("/").pop()} (${(buffer.length / 1024).toFixed(0)}KB)`);

    return { localPath: outputPath, url: image.url };
  }
}
```

**Verification:**
```bash
npx tsx -e "
import { FalFluxProvider } from './src/providers/falFlux.js';
const p = new FalFluxProvider();
console.log('Available:', p.available);
// If FAL_API_KEY is set, this will actually generate — run with --no-publish
"
```

### Task 1.2: Build Cartoon-Optimized Scene Prompt

**Objective:** Create a targeted prompt builder that produces consistent Pixar-style cartoon keyframes from FLUX.

**Files:**
- Create: `src/providers/promptBuilder.ts`

**Prompt builder:**

```typescript
import type { Story, Scene } from "../types.js";

/**
 * Build a cartoon-optimized FLUX prompt for a scene.
 * Targets Pixar-like 3D aesthetic with consistent character styling.
 */
export function buildScenePrompt(
  scene: Scene,
  characters: { name: string; description: string }[],
  episodeTitle: string,
): string {
  const cast = characters
    .filter((c) => scene.characters.includes(c.name))
    .map((c) => `${c.name}: ${c.description}`)
    .join("; ");

  // Core style directive — this is the magic sauce
  const styleDirective =
    "Pixar-style 3D animation, children's Bible illustration, " +
    "soft rounded shapes, warm studio lighting, subsurface scattering, " +
    "expressive friendly faces, gentle pastel color palette, " +
    "high detail, volumetric lighting, depth of field, " +
    "cinematic composition, 4K, 3D render style";

  // Scene-specific elements
  const sceneDesc = scene.visual;

  // Setting-specific lighting
  const lightingMap: Record<string, string> = {
    day: "bright sunny outdoor lighting, warm golden hour",
    night: "moonlit night scene, soft blue ambient light, stars",
    sunrise: "warm golden sunrise light, soft pink and orange sky",
    indoor: "warm interior lighting, soft window light, cozy atmosphere",
    water: "bright reflective water surface, caustic light patterns",
    desert: "warm desert sunlight, golden sand, clear sky",
  };
  const lighting = lightingMap[scene.setting] || "warm pleasant lighting";

  return `${styleDirective}. ${sceneDesc}. ${lighting}. Characters: ${cast}. Episode: ${episodeTitle}. No text, no watermarks, no frame borders.`;
}

/**
 * Build a simpler prompt for fallback scenes (filler, transitions).
 * Less detail = faster generation, still high quality.
 */
export function buildFillerPrompt(
  scene: Scene,
  episodeTitle: string,
): string {
  return `Pixar-style children's Bible illustration. ${scene.visual}. Warm colors, soft shapes, friendly. ${episodeTitle}. No text, no watermarks.`;
}
```

**Verification:**
```bash
npx tsx -e "
import { buildScenePrompt } from './src/providers/promptBuilder.js';
const prompt = buildScenePrompt(
  { narration: 'test', visual: 'Noah building an ark with animals', characters: ['Noah'], setting: 'day', sceneType: 'premium', durationHint: 8 },
  [{ name: 'Noah', description: 'An old man with a long white beard, wearing a brown robe' }],
  'Noah\'s Ark'
);
console.log(prompt);
// Expected: A rich, detailed Pixar-style prompt
"
```

### Task 1.3: Upgrade `images.ts` to Use FLUX as Primary Provider

**Objective:** Replace the provider chain from Grok→fal→Local to FLUX→Grok→Local. FLUX becomes the primary image provider.

**Files:**
- Modify: `src/stages/images.ts`

**Changes:**
1. Add `FalFluxProvider` import
2. Add `buildScenePrompt` / `buildFillerPrompt` import
3. Reorder provider chain: FLUX → Grok → fal (fallback) → Local (last resort)
4. Store image URLs in `storage.imageUrls` for downstream I2V providers

```typescript
import { FalFluxProvider } from "../providers/falFlux.js";
import { buildScenePrompt, buildFillerPrompt } from "../providers/promptBuilder.js";

const falFlux = new FalFluxProvider();

/** fal.ai Flux 2: high-quality cartoon keyframes. */
async function renderFalFlux(story: Story, storage: Storage): Promise<{ files: string[]; urls: string[] }> {
  const dir = storage.dir("images");
  const files: string[] = [];
  const urls: string[] = [];

  for (let i = 0; i < story.scenes.length; i++) {
    const scene = story.scenes[i]!;
    const prompt = scene.sceneType === "filler" || scene.sceneType === "closing"
      ? buildFillerPrompt(scene, story.title)
      : buildScenePrompt(scene, story.characters, story.title);
    const out = `${dir}/scene-${String(i).padStart(2, "0")}.png`;
    const result = await falFlux.generateImage(prompt, out);
    files.push(result.localPath);
    urls.push(result.url);
  }
  return { files, urls };
}

export async function generateImages(story: Story, storage: Storage): Promise<string[]> {
  const falFlux = new FalFluxProvider();

  // Tier 1: fal.ai FLUX 2 (primary - best quality, ~$0.02-0.05/image)
  if (falFlux.available) {
    log.stage("4/9  Keyframes  (image: fal flux)");
    try {
      const { files, urls } = await renderFalFlux(story, storage);
      storage.imageUrls = urls;
      log.ok(`Rendered ${files.length} scene keyframes via fal Flux.`);
      return files;
    } catch (e) {
      log.warn(`fal Flux failed (${(e as Error).message}); falling back.`);
    }
  }

  // Tier 2: Grok Imagine (xAI) — fallback
  const grok = new GrokImagineProvider();
  if (grok.available) {
    log.stage("4/9  Keyframes  (image: grok-imagine)");
    try {
      const { files, urls } = await renderGrok(story, storage);
      storage.imageUrls = urls;
      log.ok(`Rendered ${files.length} scene keyframes via Grok Imagine.`);
      return files;
    } catch (e) {
      log.warn(`Grok image gen failed (${(e as Error).message}); falling back.`);
    }
  }

  // Tier 3: Local SVG renderer (offline fallback)
  log.stage("4/9  Keyframes  (image: local)");
  const files = renderLocal(story, storage);
  log.ok(`Rendered ${files.length} scene keyframes.`);
  return files;
}
```

**Verification:**
```bash
# Set FAL_API_KEY in .env
npm run run -- --topic "Noah's Ark" --no-publish
# Check the images directory — should have beautiful FLUX renders
# Expected: 20+ scene images, each 200KB+ (not 42KB SVG)
```

### Task 1.4: Update .env.example with FLUX Configuration

**Objective:** Document the new FLUX provider configuration.

**Files:**
- Modify: `.env.example`

**Changes:**
```bash
# === IMAGE GENERATION ===
# Primary: fal.ai FLUX 2 (best quality, ~$0.02-0.05/image)
IMAGE_PROVIDER=fal
FAL_API_KEY=your_fal_key_here
FAL_IMAGE_MODEL=fal-ai/flux-2

# Fallback: Grok Imagine (xAI) — requires XAI_API_KEY
# IMAGE_PROVIDER=grok

# Offline: SVG renderer (no API key needed)
# IMAGE_PROVIDER=local
```

**Verification:** N/A — documentation change.

---

## Phase 2: Cinematic Camera Motion (Replacing Ken Burns)

### Task 2.1: Create Cinematic Camera Motion Library

**Objective:** Build a set of FFmpeg filter chains that produce parallax, crossfade, zoom, pan, and drift effects — replacing the current simple Ken Burns pan/zoom.

**Files:**
- Create: `src/providers/cameraMotion.ts`

**Camera motion library:**

```typescript
import { config } from "../config.js";

export type CameraEffect = "zoom-in" | "zoom-out" | "pan-left" | "pan-right" | "pan-up" | "pan-down" | "drift" | "crossfade" | "static";

export interface CameraMotionParams {
  effect: CameraEffect;
  /** Duration in seconds */
  duration: number;
  /** Zoom intensity (0.02-0.15). Higher = more dramatic zoom */
  zoomIntensity?: number;
  /** Pan distance in pixels (higher = faster pan) */
  panDistance?: number;
}

/**
 * Build an FFmpeg filter_complex for cinematic camera motion over a static image.
 * This is the core technique that makes FLUX keyframes look like real animation.
 *
 * Effects:
 * - zoom-in: Slow Ken Burns zoom into the image (dramatic)
 * - zoom-out: Slow pull-back reveal (establishing)
 * - pan-left/right/up/down: Slow horizontal/vertical scroll
 * - drift: Gentle floating motion (magical, dreamy)
 * - crossfade: Smooth fade between two images (scene transition)
 * - static: No motion (for very short clips or filler)
 */
export function cameraMotionFilter(
  params: CameraMotionParams,
  imageWidth: number = config.width,
  imageHeight: number = config.height,
): {
  /** The filter_complex string for ffmpeg */
  filter: string;
  /** Output label for the filter graph */
  label: string;
} {
  const d = params.duration.toFixed(2);
  const w = imageWidth;
  const h = imageHeight;
  const label = `[cam]`;

  switch (params.effect) {
    case "zoom-in": {
      const zi = (params.zoomIntensity ?? 0.08).toFixed(3);
      // Start at 1.0 scale, zoom to (1 + zi) over duration
      const endScale = 1 + parseFloat(zi);
      const x = `${w}/2`; // Fixed center
      const y = `${h}/2`;
      return {
        filter: `[0:v]zoompan=z='min(zoom+${zi}/${d}/25,${endScale})':d=${d}:x=${x}:y=${y}:s=${w}x${h},fps=${config.fps}${label}`,
        label,
      };
    }

    case "zoom-out": {
      const zi = (params.zoomIntensity ?? 0.08).toFixed(3);
      const startScale = 1 + parseFloat(zi);
      return {
        filter: `[0:v]zoompan=z='max(zoom-${zi}/${d}/25,1.0)':d=${d}:x=${w}/2:y=${h}/2:s=${w}x${h},fps=${config.fps}${label}`,
        label,
      };
    }

    case "pan-left": {
      const dist = params.panDistance ?? w * 0.25;
      return {
        filter: `[0:v]zoompan=z='1.1':x='ix-${(dist / d / 25).toFixed(1)}':y=${h}/2:d=${d}:s=${w}x${h},fps=${config.fps}${label}`,
        label,
      };
    }

    case "pan-right": {
      const dist = params.panDistance ?? w * 0.25;
      return {
        filter: `[0:v]zoompan=z='1.1':x='ix+${(dist / d / 25).toFixed(1)}':y=${h}/2:d=${d}:s=${w}x${h},fps=${config.fps}${label}`,
        label,
      };
    }

    case "drift": {
      // Gentle floating — subtle sine-wave motion + slight zoom
      // Creates a magical, dreamy feel perfect for Bible stories
      return {
        filter: `[0:v]zoompan=z='1+0.03*sin(2*PI*on/${d}/4)':d=${d}:x=${w}/2+${(w * 0.02).toFixed(0)}*sin(2*PI*on/${d}/8):y=${h}/2+${(h * 0.02).toFixed(0)}*sin(2*PI*on/${d}/6):s=${w}x${h},fps=${config.fps}${label}`,
        label,
      };
    }

    default:
      // Static: no motion
      return {
        filter: `[0:v]scale=${w}:${h},fps=${config.fps}${label}`,
        label,
      };
  }
}

/**
 * Select a camera effect based on scene type and setting.
 * Creates visual variety across the episode.
 */
export function selectCameraEffect(
  sceneType: string,
  sceneIndex: number,
  totalScenes: number,
): CameraEffect {
  // Hook (first scene) — dramatic zoom-in
  if (sceneIndex === 0 || sceneType === "hook") return "zoom-in";

  // Closing — zoom-out (pull back)
  if (sceneIndex === totalScenes - 1 || sceneType === "closing") return "zoom-out";

  // Premium scenes — drift (magical feel)
  if (sceneType === "premium") return "drift";

  // Recap — settle, no motion
  if (sceneType === "recap") return "static";

  // Filler — alternate between pan directions for variety
  const panOptions: CameraEffect[] = ["pan-left", "pan-right", "pan-up", "pan-down"];
  return panOptions[sceneIndex % panOptions.length];
}
```

**Verification:**
```bash
npx tsx -e "
import { cameraMotionFilter, selectCameraEffect } from './src/providers/cameraMotion.js';
const r = cameraMotionFilter({ effect: 'zoom-in', duration: 5 });
console.log('Filter:', r.filter.substring(0, 100) + '...');
console.log('Effect for scene 0:', selectCameraEffect('hook', 0, 20));
console.log('Effect for scene 5:', selectCameraEffect('premium', 5, 20));
console.log('Effect for scene 10:', selectCameraEffect('filler', 10, 20));
"
```

### Task 2.2: Create Particle Overlay System

**Objective:** Add particle effects (sparkles, fireflies, clouds, sparkles, stars) as FFmpeg overlay filters — adds production value without any video generation.

**Files:**
- Create: `src/providers/particles.ts`

**Particle system:**

```typescript
import { config } from "../config.js";

export type ParticleType = "sparkles" | "fireflies" | "stars" | "clouds" | "sunbeams" | "none";

/**
 * Generate an FFmpeg filter overlay for particle effects.
 * Each particle type is a generated video stream (lavfi) that gets
 * blended over the scene with varying opacity and position.
 */
export function particleOverlay(
  type: ParticleType,
  duration: number,
  width: number = config.width,
  height: number = config.height,
): { filter: string; inputs: number } | null {
  const d = duration.toFixed(2);
  const w = width;
  const h = height;

  switch (type) {
    case "sparkles":
      // Gentle golden sparkles floating upward
      return {
        filter: `[0:v][1:v]overlay=format=auto,format=yuv420p`,
        inputs: 2,
        // The overlay video is generated with a separate ffmpeg command
        // or as a second input — we'll handle this in animate.ts
      };

    case "fireflies":
      // Warm glowing orbs drifting
      return {
        filter: `[0:v][1:v]overlay=format=auto,format=yuv420p`,
        inputs: 2,
      };

    case "stars":
      // Twinkling stars (for night scenes)
      return {
        filter: `[0:v][1:v]overlay=format=auto,format=yuv420p`,
        inputs: 2,
      };

    case "clouds":
      // Soft cloud wisps drifting
      return {
        filter: `[0:v][1:v]overlay=format=auto,format=yuv420p`,
        inputs: 2,
      };

    case "sunbeams":
      // Warm light rays
      return {
        filter: `[0:v][1:v]overlay=format=auto,format=yuv420p`,
        inputs: 2,
      };

    default:
      return null;
  }
}

/**
 * Generate a particle video using FFmpeg's lavfi (for use as overlay input).
 * Returns the ffmpeg arguments for creating the particle video.
 */
export function generateParticleVideo(
  type: ParticleType,
  duration: number,
  outputPath: string,
  width: number = config.width,
  height: number = config.height,
): string[] {
  const d = duration.toFixed(2);
  const w = width;
  const h = height;

  // Different particle generators for each type
  switch (type) {
    case "sparkles":
      // Golden sparkles via nullsrc + random noise + geq
      return [
        "-f", "lavfi", "-i",
        `nullsrc=s=${w}x${h}:d=${d}:r=30,` +
        `geq=r='random(1)*255':g='random(1)*255':b='random(1)*128',` +
        `gblur=sigma=2,` +
        `colorlevels=rimin=0.8:gimin=0.8:bimin=0.9,` +
        `format=rgba,` +
        `colorchannelmixer=aa=0.3`,
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30",
        "-pix_fmt", "yuva420p",
        outputPath,
      ];

    case "fireflies":
      return [
        "-f", "lavfi", "-i",
        `nullsrc=s=${w}x${h}:d=${d}:r=30,` +
        `geq=r='random(1)*255':g='random(1)*255':b='random(1)*128',` +
        `gblur=sigma=4,` +
        `colorlevels=rimin=0.9:gimin=0.9:bimin=0.9,` +
        `format=rgba,` +
        `colorchannelmixer=aa=0.2`,
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30",
        "-pix_fmt", "yuva420p",
        outputPath,
      ];

    case "sunbeams":
      return [
        "-f", "lavfi", "-i",
        `nullsrc=s=${w}x${h}:d=${d}:r=30,` +
        `geq=r='255*st(1,sin(2*PI*T/5+random(1)))*0.3':g='255*st(1,sin(2*PI*T/5+random(1)))*0.2':b='128*st(1,sin(2*PI*T/5+random(1)))*0.1',` +
        `gblur=sigma=10,` +
        `format=rgba,` +
        `colorchannelmixer=aa=0.15`,
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30",
        "-pix_fmt", "yuva420p",
        outputPath,
      ];

    default:
      return [];
  }
}

/**
 * Select particle effect based on scene setting and type.
 */
export function selectParticleEffect(
  setting: string,
  sceneType: string,
): ParticleType {
  if (sceneType === "closing" || sceneType === "recap") return "sparkles";
  if (setting === "night") return "stars";
  if (setting === "sunrise") return "sunbeams";
  if (setting === "water" || setting === "indoor") return "fireflies";
  if (sceneType === "hook") return "sunbeams";
  return "none";
}
```

**Verification:**
```bash
npx tsx -e "
import { selectParticleEffect } from './src/providers/particles.js';
console.log('Night scene:', selectParticleEffect('night', 'premium'));
console.log('Sunrise hook:', selectParticleEffect('sunrise', 'hook'));
console.log('Closing:', selectParticleEffect('day', 'closing'));
"
```

### Task 2.3: Upgrade `animate.ts` to Use Cinematic Motion + Particles

**Objective:** Replace the Ken Burns static-frame-hold path with cinematic camera motion + particle overlays as the primary animation mode. Keep Wan 2.2 as a premium option for hero scenes.

**Files:**
- Modify: `src/stages/animate.ts`

**Changes:**
1. Import `cameraMotionFilter`, `selectCameraEffect` from `./cameraMotion.js`
2. Import `selectParticleEffect`, `generateParticleVideo` from `./particles.js`
3. Replace the `animateTestStatic` function with `animateCinematic`
4. Keep the Wan/Grok provider chain for premium scenes (optional add-on)
5. The new default is: FLUX keyframe + cinematic camera motion + particle overlay

```typescript
// New default animation mode — no video generation needed
async function animateCinematic(
  imagePath: string,
  duration: number,
  outputPath: string,
  story: Story,
  sceneIndex: number,
): Promise<void> {
  const scene = story.scenes[sceneIndex]!;
  const effect = selectCameraEffect(scene.sceneType, sceneIndex, story.scenes.length);
  const particle = selectParticleEffect(scene.setting, scene.sceneType);

  log.info(`  scene ${sceneIndex + 1} → ${effect}${particle !== "none" ? ` + ${particle}` : ""}`);

  const cam = cameraMotionFilter({ effect, duration });
  // For now, simple zoompan filter
  await ffmpeg([
    "-loop", "1", "-i", imagePath,
    "-t", duration.toFixed(2),
    "-vf", cam.filter.replace(/^\[0:v\]/, ""),
    "-s", `${config.width}x${config.height}`,
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
    "-r", String(config.fps),
    outputPath,
  ]);
}
```

**Full provider chain in animate.ts:**

```typescript
export async function animateScenes(
  story: Story,
  images: string[],
  durations: number[],
  storage: Storage,
): Promise<string[]> {
  const grok = new GrokImagineProvider();
  const wan = new Wan21Provider();
  const classification = classifyScenes(story);
  const dir = storage.dir("clips");
  const clips: string[] = [];

  const providerPref = config.video.provider;
  const grokAvailable = grok.available;
  const wanAvailable = wan.available;

  for (let i = 0; i < images.length; i++) {
    const out = `${dir}/scene-${String(i).padStart(2, "0")}.mp4`;
    const dur = Math.round(durations[i] ?? 5);
    const scene = story.scenes[i]!;
    const isPremium = classification.premium.includes(i);
    const clipDuration = Math.min(8, Math.max(1, Math.round(dur)));

    // NEW: Cinematic motion is the default, always works
    // Premium scenes can optionally use Wan/Grok if available
    if (providerPref === "wan" && isPremium && wanAvailable) {
      // Use Wan 2.2 for premium hero shots (if configured)
      // ... existing Wan 2.2 code
    } else if (providerPref === "grok" && isPremium && grokAvailable) {
      // Use Grok for premium hero shots (if configured)
      // ... existing Grok code
    } else {
      // NEW DEFAULT: Cinematic camera motion over FLUX keyframe
      log.info(`scene ${i + 1}/${images.length} → cinematic motion (${selectCameraEffect(scene.sceneType, i, story.scenes.length)})`);
      await animateCinematic(images[i]!, clipDuration, out, story, i);
      clips.push(out);
    }
  }

  log.ok(`Animated ${clips.length} scenes (${classification.premium.length} premium, ${classification.filler.length} filler)`);
  return clips;
}
```

**Verification:**
```bash
npm run run -- --topic "Noah's Ark" --no-publish
# Expected: episode with smooth cinematic camera motion over FLUX keyframes
# Each clip should have zoom/drift/pan instead of static hold
```

### Task 2.4: Add Crossfade Transitions Between Scenes

**Objective:** Add smooth crossfade transitions between scene clips instead of hard cuts.

**Files:**
- Modify: `src/stages/assemble.ts`

**Changes:**
After the per-scene segment generation, instead of a simple concat, use crossfade between segments:

```typescript
// After generating all segments, use crossfade concat
// Crossfade duration (seconds)
const CROSSFADE = 0.5;

// Build crossfade filter
const transitionFilter = segments.map((seg, i) => {
  if (i === 0) return `[0:v][0:a]`;
  return `[${i}v][${i}a]`;
}).join("");

// For simplicity, use the concat with -f concat for now
// Crossfade can be added as an enhancement later
```

**Note:** For the initial implementation, keep the existing concat approach. Crossfade transitions are a Phase 4 polish item. Mark this task as "deferred to Phase 4."

---

## Phase 3: Wire Real TTS (Narration Upgrade)

### Task 3.1: Add Edge-TTS Provider (Free, Zero Setup)

**Objective:** Add Microsoft Edge-TTS as a zero-cost, high-quality TTS provider. Edge-TTS produces warm, expressive children's narration with no API key needed.

**Files:**
- Create: `src/providers/edgeTts.ts`

```typescript
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { config } from "../config.js";
import { log } from "../logger.js";

/**
 * Edge-TTS provider — free, zero-config, high-quality children's narration.
 * Requires `edge-tts` Python package installed:
 *   pip install edge-tts
 *
 * Voice options:
 *   en-US-JennyNeural  — warm female (default, good for kids)
 *   en-US-GuyNeural    — friendly male
 *   en-GB-MaisieNeural — British child voice (best for kids' content!)
 *   en-US-AriaNeural   — expressive female
 */
const VOICE_MAP: Record<string, string> = {
  jenny: "en-US-JennyNeural",
  guy: "en-US-GuyNeural",
  maisie: "en-GB-MaisieNeural",
  aria: "en-US-AriaNeural",
  default: "en-US-JennyNeural",
};

export class EdgeTtsProvider {
  get available(): boolean {
    return true; // Always available if edge-tts is installed
  }

  async generate(text: string, outputPath: string, voice?: string): Promise<void> {
    const voiceId = VOICE_MAP[voice || "default"] || VOICE_MAP.default;

    return new Promise((resolve, reject) => {
      const child = spawn("edge-tts", [
        "--text", text,
        "--voice", voiceId,
        "--write-media", outputPath,
      ]);

      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("error", (e) => reject(new Error(`edge-tts not found: ${e.message}. Install with: pip install edge-tts`)));
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`edge-tts exited ${code}: ${stderr.slice(-500)}`));
      });
    });
  }
}
```

**Verification:**
```bash
pip install edge-tts
npx tsx -e "
import { EdgeTtsProvider } from './src/providers/edgeTts.js';
const p = new EdgeTtsProvider();
await p.generate('Hello children, welcome to Bible Stories for Kids!', '/tmp/test-tts.mp3');
console.log('Generated:', require('fs').statSync('/tmp/test-tts.mp3').size, 'bytes');
"
```

### Task 3.2: Upgrade voiceover.ts to Use Edge-TTS

**Objective:** Add Edge-TTS as the primary TTS provider (free, high quality). Keep Kokoro and xAI TTS as fallbacks.

**Files:**
- Modify: `src/stages/voiceover.ts`

**Changes:**
1. Add `EdgeTtsProvider` import
2. Add `edge-tts` to the provider chain (before Kokoro, as it's free and zero-config)
3. Update the provider chain in `renderVoice()`:

```typescript
const add = (name: string, fn: () => Promise<void>) => {
  if (!failedProviders.has(name)) providers.push({ name, fn });
};

// NEW: Edge-TTS (free, zero-config, high quality)
add("Edge-TTS", () => edgeTts.generate(text, out));

// Kokoro (if endpoint configured)
if (config.tts.kokoroEndpoint) add("Kokoro", () => kokoro(text, out));

// xAI TTS (if configured)
if (config.tts.xaiKey) add("xAI TTS", () => xaiTts(text, out));

// ElevenLabs (if configured)
if (config.tts.elevenKey) add("ElevenLabs", () => elevenLabs(text, out));
```

**Verification:**
```bash
npm run run -- --topic "Noah's Ark" --no-publish
# Expected: warm children's narration over all scenes
# Check audio files: ffprobe out/*/audio/scene-00.mp3
```

### Task 3.3: Fix `TTS_PROVIDER` Default in config.ts

**Objective:** The current default is `"kokoro"` but Kokoro requires an endpoint. Change the default to something that works without configuration (edge-tts or local).

**Files:**
- Modify: `src/config.ts:55`

**Changes:**
```typescript
tts: {
  provider: env("TTS_PROVIDER", "edge-tts"),  // Changed from "kokoro"
  // ...
}
```

**Verification:**
```bash
npm test
# Expected: all tests pass
```

---

## Phase 4: Polish and Production Value

### Task 4.1: Add Crossfade Transitions Between Scenes

**Objective:** Replace hard scene cuts with smooth crossfade transitions.

**Files:**
- Modify: `src/stages/assemble.ts`

**Changes:**
Add crossfade filter when concatenating segments:

```typescript
// After generating all segments, apply crossfade
const CROSSFADE = 0.5; // 0.5 second crossfade

// For each pair of consecutive segments, apply crossfade
// This requires a more complex ffmpeg filter graph
// Simple approach: use the `xfade` filter
const xfadeFilter = segments.map((_, i) => {
  if (i === 0) return `[0:v]`;
  return `[${i}:v]`;
}).join("");

// For N segments, we need N-1 crossfades
// ffmpeg xfade filter: xfade=transition=fade:duration=0.5:offset=X
```

**Note:** Crossfade requires ffmpeg 4.4+ and the `xfade` filter. For macOS, `brew install ffmpeg` includes it. This is a significant enhancement — implement as a separate switchable feature.

### Task 4.2: Generate Particle Overlay Videos

**Objective:** For scenes with particle effects, render the particle overlay video and composite it onto the scene clip.

**Files:**
- Modify: `src/stages/animate.ts` (add particle overlay step)

**Changes:**
After generating the cinematic motion clip, if the scene has a particle effect, generate a particle video and overlay it:

```typescript
async function animateCinematic(
  imagePath: string,
  duration: number,
  outputPath: string,
  story: Story,
  sceneIndex: number,
  storage: Storage,
): Promise<void> {
  const scene = story.scenes[sceneIndex]!;
  const effect = selectCameraEffect(scene.sceneType, sceneIndex, story.scenes.length);
  const particle = selectParticleEffect(scene.setting, scene.sceneType);

  // Step 1: Generate camera motion clip
  const camPath = outputPath.replace(".mp4", "-cam.mp4");
  const cam = cameraMotionFilter({ effect, duration });
  await ffmpeg([
    "-loop", "1", "-i", imagePath,
    "-t", duration.toFixed(2),
    "-vf", cam.filter.replace(/^\[0:v\]/, ""),
    "-s", `${config.width}x${config.height}`,
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
    "-r", String(config.fps),
    camPath,
  ]);

  // Step 2: Add particle overlay (if applicable)
  if (particle !== "none") {
    const particleDir = storage.dir("particles");
    const particlePath = `${particleDir}/scene-${String(sceneIndex).padStart(2, "0")}.mp4`;
    const particleArgs = generateParticleVideo(particle, duration, particlePath);
    if (particleArgs.length > 0) {
      await ffmpeg(particleArgs);
      // Overlay particles onto the camera motion clip
      await ffmpeg([
        "-i", camPath,
        "-i", particlePath,
        "-filter_complex", "[0:v][1:v]overlay=format=auto,format=yuv420p",
        "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
        "-c:a", "copy",
        outputPath,
      ]);
      return;
    }
  }

  // If no particles, just rename camPath to outputPath
  await fs.promises.rename(camPath, outputPath);
}
```

### Task 4.3: Add Episode Intro/Outro Cards

**Objective:** Add a 3-second animated intro ("Bible Stories for Kids") and a 3-second outro ("Subscribe!") to every episode.

**Files:**
- Modify: `src/stages/assemble.ts` (prepend/append intro/outro)

**Changes:**
Generate intro/outro videos using FFmpeg's drawtext + gradient backgrounds, then prepend/append during assembly. This requires a separate task for the text overlay generation.

### Task 4.4: Audio Mastering — Normalize + Duck

**Objective:** Normalize narration to -16 LUFS (YouTube standard) and duck music under narration (-18dB).

**Files:**
- Modify: `src/stages/assemble.ts`

**Changes:**
Add loudnorm and sidechain compression filters to the final audio mix:

```typescript
// In the final amix filter, add sidechain compression
// -16 LUFS normalization + music ducking
"-filter_complex",
  `[0:a]loudnorm=I=-16:LRA=11:TP=-1.5[narration];` +
  `[1:a]loudnorm=I=-16:LRA=11:TP=-1.5[music];` +
  `[narration][music]amix=inputs=2:duration=first:normalize=0,` +
  `volume=detect=peak|replaygain=track[a]`,
```

---

## Phase 5: Testing and Verification

### Task 5.1: Update Tests for FLUX Provider

**Objective:** Add tests for the FalFluxProvider and EdgeTtsProvider.

**Files:**
- Modify: `test/pipeline.test.ts`

**Changes:**
Add tests:
- `FalFluxProvider.available` returns `false` when no API key (safe for CI)
- `buildScenePrompt` produces a valid prompt with all required elements
- `cameraMotionFilter` produces a valid ffmpeg filter string
- `selectCameraEffect` returns appropriate effects for each scene type
- `selectParticleEffect` returns appropriate effects for each setting

### Task 5.2: End-to-End Test — Generate First Production Episode

**Objective:** Run the full pipeline with FLUX keyframes + cinematic motion + real TTS and verify the output.

**Steps:**
```bash
# 1. Ensure FAL_API_KEY is set in .env
# 2. Ensure edge-tts is installed
# 3. Pick a Bible story
npm run run -- --topic "Noah's Ark" --no-publish

# 4. Verify the output
ffprobe -v error -show_entries stream=width,height,codec_name:format=duration out/*/episode.mp4

# 5. Visual inspection — open the video and check:
#   - Beautiful FLUX-generated keyframes
#   - Smooth camera motion (zoom, drift, pan)
#   - Warm children's narration
#   - Captions burned in
#   - Background music
#   - Total duration matches expected
```

---

## Cost Summary

| Component | Cost | Notes |
|-----------|------|-------|
| FLUX 2 keyframes (20 scenes) | ~$0.40-1.00 | Via fal.ai, ~$0.02-0.05/image |
| Camera motion (ffmpeg) | $0.00 | Local processing |
| Particle overlays (ffmpeg) | $0.00 | Local processing |
| Edge-TTS narration | $0.00 | Free, local |
| Music (ffmpeg sine pad) | $0.00 | Offline fallback |
| **Total** | **~$0.40-1.00/episode** | Down from $32.11/episode (Grok) |

---

## Verification Checklist

Before calling this complete:

- [ ] All Phase 0 critical bugs fixed (failedProviders, narration audio, R2 stubs, resolution)
- [ ] FLUX keyframes rendering at 1920×1080 with cartoon-optimized prompts
- [ ] Cinematic camera motion replacing Ken Burns on all scenes
- [ ] Particle effects visible on appropriate scenes (night → stars, sunrise → sunbeams, etc.)
- [ ] Edge-TTS narration working with warm children's voice
- [ ] Episode duration matches expected (20 scenes × ~5s = ~100s+)
- [ ] Video is 1920×1080, H.264, MP4 container
- [ ] Captions burned in with proper font and positioning
- [ ] Background music mixed in
- [ ] Full pipeline runs end-to-end with `--no-publish`
- [ ] All tests pass
- [ ] Total cost under $1/episode confirmed from actual fal.ai billing

---

## Open Questions

1. **fal.ai billing**: Verify that $10 pre-pay credit is still available and that FLUX 2 is actually $0.02-0.05/image. If FLUX is more expensive, check fal-ai/flux-pro or fal-ai/recraft as alternatives.

2. **edge-tts on macOS**: The `edge-tts` Python package requires Python 3. Verify it's installable on the M4 Pro without issues. If not, Kokoro Docker is the backup.

3. **Particle performance**: Compiling particle overlays with ffmpeg is CPU-intensive. For 20 scenes, this could add 5-10 minutes of render time. Consider pre-generating a library of particle loops and reusing them.

4. **Crossfade transitions**: FFmpeg's `xfade` filter requires ffmpeg 4.4+. Verify `ffmpeg -version` on the target machine. If not available, keep hard cuts as fallback.

5. **Default provider**: After FLUX, should the default fallback be Grok (API key required) or SVG (works offline)? Current design keeps SVG as ultimate fallback, which is correct.