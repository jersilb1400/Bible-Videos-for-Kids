import type { DirectorConfig, ScreenplayInput } from "./types.js";

/**
 * Builds the system + user prompts that instruct an LLM to convert a
 * {@link ScreenplayInput} into an array of {@link DirectedShot} objects.
 *
 * The system prompt carries the directing rules (character positioning,
 * camera language, animation, timing); the user prompt carries the concrete
 * screenplay JSON and the style parameters from {@link DirectorConfig}.
 */
export class DirectorPromptBuilder {
  private readonly config: DirectorConfig;

  constructor(config: DirectorConfig) {
    this.config = config;
  }

  /** The system prompt: directing rules and output format. */
  buildSystemPrompt(): string {
    return [
      "You are an AI Director for a children's Bible-cartoon studio.",
      "You convert a story/screenplay into staged shots with character placement,",
      "camera composition, animation clip selection, and gesture timing.",
      "",
      "## Character positioning rules",
      "- Apply the RULE OF THIRDS: place the active speaker near a vertical third",
      "  line (x ≈ 0.33 or 0.67), never dead-centre unless they are the sole actor.",
      "- Dialogue facing: characters having a conversation face EACH OTHER across",
      "  the frame — the character on the left faces right, the one on the right",
      "  faces left. A single character faces camera-right by default.",
      "- Speaker prominence: the speaking character is rendered at a LARGER scale",
      "  (1.1–1.25) and positioned prominently; listening characters are slightly",
      "  smaller (0.9–1.0) and pushed toward the edge to draw the eye to the speaker.",
      "- With 3+ characters, cluster the listeners but keep the speaker visually",
      "  separated so the audience knows who is talking.",
      "",
      "## Camera composition language",
      "- `locked` — used for standard dialogue and neutral beats. Camera is static.",
      "- `push-in` — used for emotional reveals and key moments (joy, wonder,",
      "  worship, fear). Slowly approaches the subject.",
      "- `pan-left` / `pan-right` — used to establish a scene, reveal a new setting,",
      "  or follow attention across multiple characters.",
      "- Provide a `cameraRationale` in the director metadata explaining the choice.",
      "",
      "## Animation clip suggestions",
      "- `point` — when a character directs attention toward something off-screen.",
      "- `wave` — for greetings, farewells, and welcoming scenes.",
      "- `pray` — for prayer, worship, and thanking-God scenes.",
      "- `sit` / `sit-idle` — for listening characters at rest.",
      "- `walk` / `walk-left` / `walk-right` — for entrances/exits.",
      "- `look-up` — for wonder, awe, and seeing divine things.",
      "- `idle` — default neutral pose for characters with no specific action.",
      "- Assign exactly one animation suggestion per actor per shot.",
      "",
      "## Gesture timing cues",
      "- Align gestures to dialogue emphasis: a pointing gesture starts when the",
      "  speaker says the pointing word, not before.",
      "- Pause durations scale with emotional beats:",
      "    joy/wonder  → 500–700 ms (let the moment land)",
      "    sad/afraid  → 400–600 ms (give weight)",
      "    neutral     → 200–300 ms (keep moving)",
      "    brave       → 350–450 ms (resolve with purpose)",
      "- Provide `gestureTiming` entries keyed to `lineId` with startMs/durationMs",
      "  relative to the start of that line's audio.",
      "",
      "## Reaction shots",
      "- For each dialogue line, consider whether a *listening* character should",
      "  get a reaction shot. Add a `reactionShots` entry with the listener's",
      "  `characterId`, the `triggerLineId`, and the emotion their face should show.",
      "- Reaction shots are only suggestions — the editor decides whether to cut.",
      "",
      "## Output format",
      "Return ONLY a JSON object (no markdown fences, no prose) of the shape:",
      "{",
      "  \"shots\": [",
      "    {",
      "      \"id\": \"shot-1\",",
      "      \"settingId\": \"<alphanumeric-and-dashes>\",",
      "      \"actors\": [",
      "        { \"characterId\": \"<id>\", \"x\": 0.5, \"y\": 0.5, \"scale\": 1.2,",
      "          \"pose\": \"wave\", \"facing\": \"right\" }",
      "      ],",
      "      \"leadIn\": { \"text\": \"...\", \"pauseAfterMs\": 400 },",
      "      \"dialogue\": [",
      "        { \"id\": \"line-1\", \"speakerId\": \"<id>\", \"text\": \"...\",",
      "          \"emotion\": \"joy\", \"pauseAfterMs\": 600 }",
      "      ],",
      "      \"action\": \"short stage direction\",",
      "      \"camera\": \"push-in\",",
      "      \"director\": {",
      "        \"staging\": \"why characters are placed this way\",",
      "        \"cameraRationale\": \"why this camera move\",",
      "        \"animationSuggestions\": [",
      "          { \"characterId\": \"<id>\", \"clipId\": \"wave\", \"reasoning\": \"...\" }",
      "        ],",
      "        \"gestureTiming\": [",
      "          { \"lineId\": \"line-1\", \"startMs\": 0, \"durationMs\": 800, \"gesture\": \"wave\" }",
      "        ],",
      "        \"reactionShots\": [",
      "          { \"characterId\": \"<id>\", \"triggerLineId\": \"line-1\", \"emotion\": \"joy\" }",
      "        ]",
      "      }",
      "    }",
      "  ]",
      "}",
      "",
      "Rules:",
      "- `characterId` values must be lowercased, hyphenated versions of the",
      "  character names (e.g. \"King Darius\" → \"darius\").",
      "- Every `speakerId` must be one of the provided character ids and must also",
      "  appear in that shot's `actors`.",
      "- Shot ids and dialogue line ids must be unique across the whole episode.",
      "- `settingId` must be alphanumeric + dash/underscore only (no spaces).",
      "- `x`, `y` are normalised [0,1]. `scale` is a positive multiplier.",
      "- `facing` is \"left\" or \"right\".",
      "- `emotion` (dialogue + reactions) is one of: neutral, joy, sad, afraid, brave, wonder.",
      "- `camera` is one of: locked, push-in, pan-left, pan-right.",
      "- Every non-legacy shot must have at least one dialogue line.",
      "- Content must be gentle, joyful, and safe for children ages 3–8.",
    ].join("\n");
  }

  /** The user prompt: the concrete screenplay + style parameters. */
  buildUserPrompt(input: ScreenplayInput): string {
    const c = this.config;
    const style = [
      `Target audience: ages ${c.targetAge}`,
      `Tone: ${c.tone}`,
      `Pacing: ${c.pacing}`,
      `Humour level: ${c.humorLevel}`,
    ].join("\n");

    const characters = input.characters
      .map((ch, i) => {
        const id = canonicalId(ch.name);
        return `  ${i + 1}. "${ch.name}" (id: "${id}") — ${ch.description}`;
      })
      .join("\n");

    const scenes = input.scenes
      .map((sc, i) => {
        const chars = sc.characters.length > 0 ? sc.characters.join(", ") : "(none)";
        return [
          `  Scene ${i + 1}:`,
          `    narration: ${sc.narration}`,
          `    visual: ${sc.visual}`,
          `    characters present: ${chars}`,
          `    setting: ${sc.setting}`,
        ].join("\n");
      })
      .join("\n");

    const screenplay = [
      "## Screenplay",
      `Title: ${input.title}`,
      `Source: ${input.source}`,
      `Lesson: ${input.lesson}`,
      "",
      "## Characters",
      characters,
      "",
      "## Scenes",
      scenes,
    ].join("\n");

    return [
      `Convert the following children's Bible story into staged shots.`,
      `Follow all the directing rules in the system prompt.`,
      `Produce one shot per scene, with full director metadata.`,
      "",
      `## Directing style`,
      style,
      "",
      screenplay,
      "",
      "Return ONLY the JSON object (no markdown fences, no commentary).",
    ].join("\n");
  }

  /** Returns both prompts as a tuple for the chat completion call. */
  build(input: ScreenplayInput): { system: string; user: string } {
    return { system: this.buildSystemPrompt(), user: this.buildUserPrompt(input) };
  }
}

/** Canonical, lowercased, hyphenated id derived from a character name. */
export function canonicalId(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "-");
}
