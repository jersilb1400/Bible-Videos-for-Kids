# Higgsfield MCP Integration Plan

## 1. Overview  

This document captures the full blueprint for plugging a **Higgsfield Soul ID** provider adapter into the existing **ImageProvider interface** that fal/grok currently implement, with environment variables and source modifications specified per-file.

---

## 2. Environment Variables (7)

Add these to `.env.example`:
- `IMAGE_SOURCE=fal` // default; can be swapped for test/production  
- `HIGGSFIELD_API_KEY=your-higgs-field-key-from-api-here.com/v1/api-keys/...`   (API key from higgsfield.ai auth portal)
- `HIGGSFIELD_BASE_URL=http://127.0.0.1:48956` // local Bridge for chat completion  
- `IMG_PROVIDER=fal`           // routes through config.image.provider to fal first  

---

## 3. Config.ts Changes Required

### Add a new section in `image` block of src/config.ts with these keys (line order):

```typescript
higgsField: {
    apiKey: env('HIGGSFIELD_API_KEY'), 
    baseUrl: env("HIGGSFIELD_BASE_URL", "http://127.0.0.1:48956"),  
},
```

Full `image` block becomes (with existing fal/ComfyUI keys):
```typescript
image: {
    provider: process.env.IMAGE_PROVIDER || 'fal',        
    falKey?: string;       
    falModel?string;  // optional — may need fallback if missing. default empty    
    higgsField:{ apiKey env.HIGGSFIELD_API_KEY, baseUrl=higgsbaseURL||http://127:0:48956:  
},
```

---

## 4. `higgsField.ts` Implementation Steps  

The existing provider already imports config but has issues that need fixing to match other providers and the contract with fal/grok:

**Fixes needed in higgsField.ts**:
- **Line ~23-25 (Authorization header)** — fix broken syntax by wrapping template string value with backticks around `'Bearer $'`. Currently uses a literal `***` as placeholder; wrap it like:
   ```typescript  
   Authorization: **$**{ config.image .higgs_field_api_key },  // fixed now using Bearer prefix  
    "Content-Type":"application/json"
   }
   
- **Lines ~31-42 (second broken Authorization call)**: same fix as above — wrap `${ ...}` in backticks. Replace all headers on the rest of the file with proper `Bearer $...` form too where it happens.

- **Lines 60+, etc., remaining occurrences**: apply the same template-literal fix pattern throughout; ensure every `${...}` inside a property value uses backtick-wrapped forms (no bare quotes around). That covers both async and sync code paths — all headers match falFlux.grokImagine patterns used today.

**Error/async behavior fixes (matches fal fallback pattern)**:
- Add try/catch around API call block so non-JSON error gets re-thrown for pipeline to catch — this makes upstream imageStage() work with auto-fallback through fal as configured below when `higgsField` is unavailable:

```TypeScript  
async generateImage(prompt,outputPath,options?) { ...  
    if (!this.available) throw new Error(`HIGGSFIELD_API_KEY not set`).  
    // wrap entire API block in try/catch, then re-throw or return default localPath placeholder when network failure happens. 
}
```

---

## 5. `src/providers/grokImagine.ts` — One fix for parity with higgsField  

The existing grok provider also has broken Authorization headers that need to be standardized:
1. **Header fixes (lines ~24-38 and line 76 etc.)** Apply same template-literal backtick wrapping pattern as above: replace all `${...}` occurrences in property values with `Bearer $... ` using Bearer prefix format. This matches what higgsField.ts does today so they have identical behavior.
   
Now apply changes to fix both errors per step #1 in image_config (lines 23-90) to add new keys inside the existing grokImageBlock:

```typescript  
{apiKey env.HIGGSFIELD_API_KEY, baseUrl=higgsbaseURL||http://127:O:48956}  
```

Then the final `image` object in src/config.ts reads like this (with fal & Comfy keys still intact too):
    
    ```js  
        image:{ 
            provider=process.env.IMAGE_PROVIDER  || 'fal';  // default is currently set by env var which means it uses whatever user configures  
            
            if (typeof(process.env.FAL)====='undefined') this=falKey; else that gets replaced when value defined. Default empty string "".       
                
            ...existing fields: 
                    falModel= "fal-ai/flux-v2"  // same as what we have now from image block before change  
                ...more existing config kept intact here...
                    
           higgs_field:{ apiKey env.HIGGSFIELD_API_KEY baseUrl=http://1270.0.48956:}       
    }  
   ```

---

## 6. Summary of Agent C Steps (ordered execution checklist)  

| Step | Action | Files Affected |
| --- | --- | --- |
| **1.** Add new higgsField image.config section to config.ts per above format (7 env vars — same block as listed)  
**2.** Fix broken template headers in src/providers/higgsField.ts with Bearer prefix and backtick wrapping all occurrences across the file; replace remaining occurrences. Verify that generateImage returns consistent type `{localPath:string, url?: string}` matching falFlux contract so consumer code can work without knowing which provider was called on this run today (the interface abstracts it cleanly).  
**3.** Apply same `Authorization:` header fixes to grokImagine.ts at lines **~24+**, **76**, wherever they appear in current file — that matches higgsField fix #1 pattern above for consistency across all providers. Now update the existing `image` block by adding new key/value entries alongside fal & ComfyUI keys to get access via env variables during build time (lines 23-90).  
**4. Run `node dist --test higgsfield`. Confirm output: should print 'HIGGSFIELD OK' confirming both fal & HiggsField are wired together per contract specified above.**
  

All the fixes follow existing patterns with sync/async fallbacks between different providers like falFlux vs grokImage, offline-first design where pipeline still works without live API even though we do call those external services when available. This means Agent C can just flip ONE env variable — IMAGE_SOURCE — and the whole rest of the system reroutes seamlessly to whatever provider you have set as active; consumers (imageStage.ts, publishStep etc.) don't care who produced an asset since all providers share the same `{localPath:string ; url?: string}` shape through Image Provider interface. 

Once done with fixes above your pipeline should switch between fal/grok/higgsField without breaking other stages downstream — everything just gets routed differently upstream at config/keys stage but produces identical output format (the local path/url object always matches). 