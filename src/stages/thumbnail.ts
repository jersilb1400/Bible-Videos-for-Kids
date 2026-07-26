import { writeFileSync } from "node:fs";
import { config } from "../config.js";
import { log } from "../logger.js";
import { ffmpeg, hasDrawtext } from "../providers/ffmpeg.js";
import type { Storage } from "../storage.js";
import type { Story } from "../types.js";

const FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf";
const DRAWTEXT_AVAILABLE = hasDrawtext();

/** Eye-catching 1280x720 thumbnail from the opening keyframe + bold title. */
export async function generateThumbnail(
  story: Story,
  images: string[],
  storage: Storage,
): Promise<string> {
  log.stage("8/9  Thumbnail");
  const out = storage.path("thumbnail.jpg");
  const first = images[0]!;

  if (DRAWTEXT_AVAILABLE) {
    const titleFile = storage.path("title.txt");
    const title = story.title.length > 28 ? story.title.replace(/\s+(\S+)$/, "\n$1") : story.title;
    writeFileSync(titleFile, title);
    const fontSize = 96;
    const drawtext =
      `drawtext=fontfile=${FONT}:textfile=${titleFile}:expansion=none:` +
      `fontcolor=white:fontsize=${fontSize}:line_spacing=8:borderw=8:bordercolor=0x3a2f5b:` +
      `box=1:boxcolor=0xff7eb6AA:boxborderw=24:x=(w-text_w)/2:y=h*0.62`;
    await ffmpeg([
      "-i", first,
      "-vf", `scale=1280:720,${drawtext}`,
      "-frames:v", "1", "-q:v", "2",
      out,
    ]);
  } else {
    // Graceful degradation: just scale the first image
    log.warn("drawtext not available — thumbnail without title text");
    await ffmpeg([
      "-i", first,
      "-vf", "scale=1280:720",
      "-frames:v", "1", "-q:v", "2",
      out,
    ]);
  }

  log.ok(`Thumbnail: ${out}`);
  return out;
}
