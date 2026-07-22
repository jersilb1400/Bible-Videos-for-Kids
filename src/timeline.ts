import type { Episode, Shot, DialogueLine } from "./types.js";
import type { SpeechClip } from "./providers/speech.js";

export interface PlacedUtterance {
  utteranceId: string;
  shotId: string;
  speakerId: string;
  text: string;
  startMs: number;  // episode-relative
  endMs: number;
  isLeadIn: boolean;
}

export interface ShotTimeline {
  shotId: string;
  startFrame: number;
  endFrame: number; // exclusive
  durationMs: number;
  utterances: PlacedUtterance[];
}

export interface EpisodeTimeline {
  totalFrames: number;
  totalMs: number;
  fps: number;
  shots: ShotTimeline[];
}

/**
 * Compile an authoritative episode timeline from the episode script and
 * real speech clip durations. All timing in integer milliseconds to avoid
 * floating-point accumulation.
 */
export function compileTimeline(
  episode: Episode,
  clips: Map<string, SpeechClip>,
  fps: number = 30,
): EpisodeTimeline {
  const shots: ShotTimeline[] = [];
  let cursorMs = 0;
  let cursorFrame = 0;

  for (const shot of episode.shots) {
    const utterances: PlacedUtterance[] = [];
    const shotStartMs = cursorMs;

    // Lead-in narration first (if present)
    if (shot.leadIn) {
      const leadInId = `${shot.id}-leadin`;
      const clip = clips.get(leadInId);
      if (clip) {
        utterances.push({
          utteranceId: leadInId,
          shotId: shot.id,
          speakerId: "narrator",
          text: shot.leadIn.text,
          startMs: cursorMs,
          endMs: cursorMs + clip.durationMs,
          isLeadIn: true,
        });
        cursorMs += clip.durationMs;
        // Add leadIn pause
        cursorMs += shot.leadIn.pauseAfterMs;
      }
    }

    // Then dialogue lines
    for (const line of shot.dialogue) {
      const clip = clips.get(line.id);
      if (!clip) {
        throw new Error(`Missing speech clip for line "${line.id}"`);
      }
      utterances.push({
        utteranceId: line.id,
        shotId: shot.id,
        speakerId: line.speakerId,
        text: line.text,
        startMs: cursorMs,
        endMs: cursorMs + clip.durationMs,
        isLeadIn: false,
      });
      cursorMs += clip.durationMs;
      cursorMs += line.pauseAfterMs;
    }

    const shotDurationMs = cursorMs - shotStartMs;
    const shotFrames = Math.ceil((shotDurationMs * fps) / 1000);

    shots.push({
      shotId: shot.id,
      startFrame: cursorFrame,
      endFrame: cursorFrame + shotFrames,
      durationMs: shotDurationMs,
      utterances,
    });

    cursorFrame += shotFrames;
  }

  return {
    totalFrames: cursorFrame,
    totalMs: cursorMs,
    fps,
    shots,
  };
}
