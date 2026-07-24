/**
 * Unified voice registry — maps character IDs (and legacy rig voice keys)
 * to Microsoft Edge-TTS voice names.
 *
 * The speech stage passes `voiceId = line.speakerId` (the character ID, e.g.
 * "daniel", "narrator", "mother"). Edge-TTS expects Microsoft voice names
 * like "en-US-GuyNeural". This registry bridges that gap.
 *
 * Resolution order for an incoming voiceId:
 *   1. If it already looks like a Microsoft voice name (contains "Neural"),
 *      pass it through unchanged.
 *   2. If it is a key in VOICE_REGISTRY, map it.
 *   3. Otherwise fall back to DEFAULT_VOICE.
 *
 * Voice notes:
 *   - en-US-DavisNeural previously failed with NoAudioReceived; male authority
 *     figures use en-US-BrianNeural instead.
 *   - elder/king fall back to en-US-EricNeural (deep male) when Davis is unavailable.
 */

/** Character ID / rig key → Microsoft Edge-TTS voice name. */
export const VOICE_REGISTRY: Record<string, string> = {
  // Core cast
  narrator: "en-US-ChristopherNeural", // narrator — calm, storytelling male
  daniel: "en-US-GuyNeural",          // young man, friendly
  mother: "en-US-JennyNeural",        // warm female
  darius: "en-US-BrianNeural",        // authoritative male (Davis failed)
  angel: "en-US-AriaNeural",          // expressive female
  elder: "en-US-EricNeural",           // elder — deep male (Davis fallback)
  child: "en-GB-MaisieNeural",        // British child voice
  king: "en-US-EricNeural",            // deep male (Davis fallback)

  // Legacy rig voice keys (from the old edgeTts.ts VOICE_MAP) kept for back-compat
  jenny: "en-US-JennyNeural",
  guy: "en-US-GuyNeural",
  maisie: "en-GB-MaisieNeural",
  aria: "en-US-AriaNeural",
};

/** Fallback voice when a voiceId is not in the registry. */
export const DEFAULT_VOICE = "en-US-JennyNeural";

/**
 * Resolve any voiceId (character name, rig key, or raw Microsoft voice name)
 * to a valid Edge-TTS voice name string.
 *
 * @example resolveVoice("daniel")        // "en-US-GuyNeural"
 * @example resolveVoice("en-US-AriaNeural") // pass-through
 * @example resolveVoice("unknown-char") // "en-US-JennyNeural" (fallback)
 */
export function resolveVoice(voiceId: string | undefined): string {
  if (!voiceId) return DEFAULT_VOICE;

  // Pass through raw Microsoft voice names (e.g. "en-US-GuyNeural", "en-GB-MaisieNeural").
  // Edge-TTS voice names always end in "Neural" (and the en-/xx-XX locale prefix).
  if (/^[a-z]{2}-[A-Z]{2}-\w+Neural$/.test(voiceId)) {
    return voiceId;
  }

  // Character ID or rig key lookup.
  const mapped = VOICE_REGISTRY[voiceId];
  if (mapped) return mapped;

  // Unknown character — fall back to the default warm female voice.
  return DEFAULT_VOICE;
}

/** All distinct Microsoft voice names available in the registry (for diagnostics). */
export function availableVoices(): string[] {
  return [...new Set(Object.values(VOICE_REGISTRY))];
}
