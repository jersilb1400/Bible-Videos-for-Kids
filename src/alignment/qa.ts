/**
 * QA validation for lip-sync tracks.
 *
 * Catches the errors that break downstream rendering:
 *   - Cues outside [0, duration]
 *   - Gaps between cues (mouth freezes)
 *   - Off-speaker mouth movement (other speakers should be at rest)
 */
import type { LipSyncTrack } from "../lipsync/types.js";
import { validateLipSyncTrack } from "../lipsync/types.js";

/** QA result — always populated, even on success so the caller can log. */
export interface QAResult {
  /** Whether the track passed all checks. */
  passed: boolean;
  /** Human-readable issues (empty on success). */
  issues: string[];
}

/**
 * Validate a lip-sync track against QA rules.
 *
 * Beyond the structural checks in {@link validateLipSyncTrack} (which throws
 * on structural failures), this adds:
 *   - Cues must stay within [0, duration]
 *   - No gaps > 50ms between cues (mouth would freeze)
 */
export function validateTrackQA(track: LipSyncTrack): QAResult {
  const issues: string[] = [];

  // Structural validation (throws on hard failure)
  try {
    validateLipSyncTrack(track);
  } catch (err) {
    return {
      passed: false,
      issues: [`STRUCTURAL: ${(err as Error).message}`],
    };
  }

  const duration = track.audio.durationSec;
  const cues = track.cues;

  if (cues.length === 0) {
    issues.push("No cues in track");
    return { passed: false, issues };
  }

  // Check cue boundaries
  for (const cue of cues) {
    if (cue.startSec < 0) {
      issues.push(`Cue starts before 0: ${cue.startSec}s`);
    }
    if (cue.endSec > duration + 0.001) {
      issues.push(`Cue extends past duration: ${cue.endSec}s > ${duration}s`);
    }
  }

  // Check for gaps > 50ms
  for (let i = 1; i < cues.length; i++) {
    const gap = cues[i]!.startSec - cues[i - 1]!.endSec;
    if (gap > 0.05) {
      issues.push(
        `Gap > 50ms between cues ${i - 1} and ${i}: ${gap.toFixed(3)}s ` +
        `(${cues[i - 1]!.endSec}s → ${cues[i]!.startSec}s)`
      );
    }
  }

  return { passed: issues.length === 0, issues };
}

/**
 * Ensure off-speaker mouths are at rest.
 *
 * When multiple speakers are active (e.g., overlapping dialogue), the non-speaking
 * characters should have their mouth shapes set to X. This check validates that
 * a track's cues are X during the time windows where another speaker is talking.
 *
 * @param track The track to check (should be an off-speaker track)
 * @param speakerActiveWindows Time ranges where the *other* speaker is talking
 */
export function validateOffSpeakerAtRest(
  track: LipSyncTrack,
  speakerActiveWindows: { start: number; end: number }[],
): QAResult {
  const issues: string[] = [];

  for (const window of speakerActiveWindows) {
    for (const cue of track.cues) {
      // Check if this cue overlaps with the other speaker's active window
      if (cue.startSec < window.end && cue.endSec > window.start) {
        if (cue.shape !== "X") {
          issues.push(
            `Off-speaker ${track.speakerId} has ${cue.shape} during ` +
            `other speaker's active window [${window.start}s, ${window.end}s]`
          );
        }
      }
    }
  }

  return { passed: issues.length === 0, issues };
}