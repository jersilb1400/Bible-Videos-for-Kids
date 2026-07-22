# Bible Videos for Kids — `src/stages/images.ts` (Stage 4)

## Purpose  

The **Stage 4 keyframer** is responsible for producing the per‑scene cartoon stills that will later drive each clip's animation. It has two execution paths:

- **Offline path** uses deterministic SVG rendering when production providers are disabled.  
- **Production path** routes through one of three external services (`fal`, `grok-imagine` or a local ComfyUI endpoint) chosen by the active `$IMAGE_PROVIDER` environment variable (default to fal / FLUX 2).

---

##  Pipeline Position & Data Flow  

Image keyframing runs **after voiceover (Stage 3)** so that real‑time TTS durations are available as scene timing constraints. Each `Scene.visual` description plus any character reference sheets get passed straight into the active provider's API call; output files land in `<outputDir>/images/`.

```
Stage 1    ────▶ Stage 2         ◈️  Stage 3                Stage 4 ← you are here
Story   ┌──── Safe‑check    ▶  Voiceover (Edge‑TTS)              Images
        │                  │                                        │
       Output             output                                images/
```

---

## Offline Fallback — SVG Scene Renderer  

When `$IMAGE_PROVIDER=local` (or the production key is missing), Stage 4 falls back to a pure offline SVG renderer. This keeps development, testing and demos cheap and deterministic:

```typescript
const renderFn = await resolveRenderFunction(scene);  // picks offline or prod
await renderFn(scene, outputPath);                     // writes PNG/SVG
log.info("Saved keyframe", { path : ... });
```

**What the offline renderer produces**: a flat vector scene with character silhouettes positioned per their `characters` list and background shapes derived from each scene's `setting`. No API calls are made — just an SVG file written to `<outputDir>/images/<scene‑N>.svg` (and optionally rasterised to PNG by resvg if you enable the option).

The offline path is wired in as the first step; every subsequent branch only fires when one or more production APIs are successfully reachable. That way, even with zero credentials the pipeline still completes and produces usable output for story‑boarding.

```typescript
// Fallback to local SVG renderer when IMAGE_PROVIDER unset  
if (!process.env.IMAGE_PROVIDER) {  
  return renderOffline(scene);  
} else { // otherwise pick one of your configured APIs based on variable value set earlier...
   await fetchImageAPI(process.env['IMAGE_PROVIDER']);  
}  
log('Rendered keyframe', scene.imagePath);
```

---

## Production Branches (Provider Dispatch)  

When `$IMAGE_PROVIDER` is set and valid, Stage 4 **dispatches** based on its value. The dispatch is straightforward: only ONE active branch runs per call — there are no multiplexing strategies across APIs in the current codebase. Providers available today:

| Provider | Env switch | Endpoint / model used | Cost notes |
| :--- | --- | --- | --- |
| **fal.ai (FLUX 2)** (DEFAULT) | `IMAGE_PROVIDER=fal` | `https://image-generation-model.com/flux2/generate` | ~$0.02‑0.05/img @ 1080p, uses `FAL_IMAGE_MODEL` to swap if needed |
| **Grok Imagine** | `IMAGE_PROVIDER=grok-imagine` | `https://api.x.ai/v1/images/generations` (xAI API) | Charged as image units against your account balance on xAI portal; use XAI_KEY to authenticate calls and set XAI_IMAGE_MODEL env var if you want different model than default `grok-imagine-image-quality`. Quality fallback exists via standard/quality toggled inside the function call body itself (default quality=`standard` but upgrade inline). |
| **ComfyUI (local)** | `IMAGE_PROVIDER=comfyui` (or wherever user has installed) | Self‑hosted workflow endpoint pointed at `$COMFYUI_ENDPOINT` — typically a Flux or SD‑XL node graph on same machine, no cloud cost after GPU spins up. Requires ComfyUI to be running and an API key set in env (optional depending setup), plus either `--image_prompt <file>` or stdin pipe containing base prompt string. |

If an unexpected provider value is detected at runtime (`IMAGE_PROVIDER=foo-nonexistent` for example) the dispatch falls through to a hard fail with message `"Unknown $IMAGE_PROVIDER: ..."`. That's the only code path that raises — every working configuration either succeeds silently (and writes to disk), uses offline SVG fallback or routes cleanly into one of three production providers above. Nothing else should be expected here.

```typescript
// dispatch by IMAGE_PROVIDER value  
const provider = await resolveProviderFromEnv;   // throws if unknown value found  
if (provider === "local") { ... renderOffline } 
else {  // otherwise call the matching API...
   const response = await provider.generateImage({
       prompt : scene.visual + extra context,   // characters list appended automatically here via promptBuilder.ts in src/providers/ directory before sending off; character palette colours come from Scene's `characters` field for consistency across scenes too (locks identity)  
   });
    log("Got image URL", response.url);        // print for debugging only - prod doesn't need it unless you want track assets somewhere else (eg YouTube video upload step below uses localPath rather than url directly today because we want determinism in file naming scheme regardless which provider ended up running last)      
}  
```

The dispatch pattern mirrors what happens between `$VIDEO_PROVIDER` values in **Stage 5 animate.ts** too; same idea there but different set of endpoints. No cross‑provider multiplexing logic anywhere — just a simple if/else chain over env var value per stage.

---

## Error Handling Strategy  

Every failure mode on the production branch bubbles up as an exception that **the orchestrator catches and retries one additional pass with `$IMAGE_PROVIDER=local`** enabled, ensuring final output always lands regardless of network or API issues:

```typescript
await callApiWithErrorHandler(scene);     // throws if anything goes wrong mid‑generate  
catch (error) { log.warn ("Retrying keyframe render offline");  /* fall back */ return; }
```

That's the only retry policy — **no exponential backoff, no jitter timers or third-party service health checks run before invoking external API calls during image generation step here** because the design choice up top says "fail fast on bad input but recover gracefully". The catch also includes any non‑JSON parse errors (malformed responses should not crash downstream consumers anyway — just mark scene as missing and let pipeline log that for auditing later if someone cares to fix).

What's NOT in this function:
- No polling or async state management (fal.ai returns sync or `request_id` per request so user doesn't need wait loops themselves; handle those internally inside provider client libraries where they belong)  
- No retry policies — one attempt only, fail hard if something is wrong on input side  
- No logging verbosity beyond standard `.info` level from logger.ts (use .debug() for verbose tracing when troubleshooting problems locally during development phase since info gets written out too often by default)
- No caching between calls within same pipeline run — each `Scene.visual` prompt produces a fresh render; identity consistency happens at prompt construction time via promptBuilder.ts not at caching layer because characters must always regenerate per scene in current architecture (otherwise you lose pose variation across sequences which defeats the purpose of keyframing anyway)

---

## Logging Output  

Stage 4 emits structured console output that other stages consume downstream:

- `"Saved keyframe"` — confirms image landed at given `outputPath`
- `"Retrying keyframe render offline"` and `"Rendered fallback keyframe with SVG"` (only when falling back after production branch failure; otherwise never shown)

No intermediate progress bars or partial‑download telemetry exist either today on purpose since the file write happens in one shot via `writeFileSync`. The offline renderer itself also writes a single SVG file directly to disk without any step markers — just final result appears in `<outputDir>/images/`. That's consistent with how Stage 5 animate.ts behaves too; same pattern across providers. 

If you want additional detail during development, use logger's `.debug()` method (level `3`) rather than bumping info-level noise since production logs are already at default level 2 (`info`).

---

## Test Hooks  

For CI / integration verification purposes the offline SVG writer has a dedicated **`--save-rendering-test-svg=true`** flag you can pass via CLI when running tests so output lands in known location regardless of which provider was actually invoked during that execution run:

```
npm test --keyframe --provider fal --save-rendering-test-svg=true   # writes expected SVG to fixtures/ dir for regression comparison.  
```

No other test‑specific switches exist on this function — everything else is just production behavior. The flag only affects offline branch because production providers don't write deterministic files (network + API response timing means you can never guarantee exact bytes match from run to run; offline path does though since it's pure SVG math so useful for catching regressions in renderer itself without having to maintain fixtures against live API output). 

---

## Summary of Design Decisions  

1. **Offline-first fallback keeps pipeline runnable with zero credentials**
2. **Provider dispatch follows env‑var pattern already used elsewhere; add new provider only needs one branch addition not cross-cutting changes throughout** — same idea as VIDEO_PROVIDER selection in next stage  
3. **Character‑consistent prompts built outside this function** (via `promptBuilder.ts`) keep per‑scene visual descriptions consistent across entire series without requiring prompt engineering inside Stage 4 itself which keeps responsibilities separated cleanly too.
4. **No multiplexing between APIs; one active at a time, switchable by setting IMAGE_PROVIDER** — mirrors how `$VIDEO_PROVIDER` works next stage down  
5. **One retry with local fallback on failure only; no complex backoff or polling logic here either in current implementation since fal/grok return responses inline without async state machine involvement (handle those internally where they belong inside respective provider clients not at orchestration layer)
6. **Logging minimal and structured to avoid noise pollution** — only `.info` level outputs by default for clarity; use `.debug()` if you need more granular traces while investigating local problems during dev cycle. Production systems don't have access to lower‑level log categories anyway because they hit rate limits too fast (use .warn() sparingly when something is wrong but recoverable since that gets shipped off for auditing later on).

