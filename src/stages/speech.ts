import { log } from "../logger.js";
import { config } from "../config.js";
import { createSpeechProvider, type SpeechProvider, type SpeechClip, type SpeechRequest } from "../providers/speech.js";
import type { Episode, DialogueLine } from "../types.js";
import { Storage } from "../storage.js";

export interface SpeechResult {
  clips: Map<string, SpeechClip>; // utteranceId → SpeechClip
}

/**
 * Generate one isolated WAV per dialogue utterance across all shots.
 * Each clip is stored under <storage>/speech/<utteranceId>.wav
 */
export async function generateSpeech(episode: Episode, storage: Storage): Promise<SpeechResult> {
  log.stage("Speech  (per-utterance TTS)");

  const provider = createSpeechProvider(config.tts.provider);
  log.info(`Provider: ${provider.id}`);

  const clips = new Map<string, SpeechClip>();

  for (const shot of episode.shots) {
    for (const line of shot.dialogue) {
      const clip = await synthesizeLine(line, provider, storage);
      clips.set(line.id, clip);
    }

    // Also synthesize leadIn narration if present (uses narrator voice)
    if (shot.leadIn) {
      const leadInId = `${shot.id}-leadin`;
      const clip = await synthesizeLeadIn(shot.leadIn.text, leadInId, provider, storage);
      clips.set(leadInId, clip);
    }
  }

  log.ok(`${clips.size} speech clips generated`);
  return { clips };
}

async function synthesizeLine(
  line: DialogueLine,
  provider: SpeechProvider,
  storage: Storage,
): Promise<SpeechClip> {
  const cast = config.tts;
  const outputPath = `${storage.root}/speech/${line.id}.wav`;

  const req: SpeechRequest = {
    utteranceId: line.id,
    speakerId: line.speakerId,
    voiceId: line.speakerId, // resolved through rig manifest in production
    text: line.text,
    emotion: line.emotion,
    rate: 1.0,
    pitch: 0,
    outputPath,
  };

  return provider.synthesize(req);
}

async function synthesizeLeadIn(
  text: string,
  id: string,
  provider: SpeechProvider,
  storage: Storage,
): Promise<SpeechClip> {
  const outputPath = `${storage.root}/speech/${id}.wav`;

  const req: SpeechRequest = {
    utteranceId: id,
    speakerId: "narrator",
    voiceId: "narrator",
    text,
    emotion: "neutral",
    rate: 1.0,
    pitch: 0,
    outputPath,
  };

  return provider.synthesize(req);
}
