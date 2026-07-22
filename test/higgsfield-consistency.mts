import { HiggsFieldProvider } from "../src/providers/higgsField.js";
import { mkdirSync } from "node:fs";

const h = new HiggsFieldProvider();
mkdirSync("out/test-higgsfield", { recursive: true });

const prompts = [
  "young shepherd David playing harp, warm golden light, cartoon Bible storybook style",
  "young shepherd David with brown curly hair and tan robe standing before King Saul, same character, same style",
  "David the shepherd boy playing lyre, ancient Israel palace background, consistent character appearance"
];

async function run() {
  for (const [i, prompt] of prompts.entries()) {
    console.log("--- Scene", i + 1, "---");
    try {
      const r = await h.generateImage(prompt, `out/test-higgsfield/david-${i + 1}.png`);
      console.log("SUCCESS:", r.url);
    } catch (e) {
      console.error("FAILED:", (e as Error).message);
    }
  }
}

run();