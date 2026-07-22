import { HiggsFieldProvider } from "../src/providers/higgsField.js";
import { mkdirSync } from "node:fs";

const h = new HiggsFieldProvider();
console.log("available:", h.available);

mkdirSync("out/test-higgsfield", { recursive: true });

try {
  const result = await h.generateImage(
    "young shepherd David playing harp, warm golden light, cartoon Bible storybook style",
    "out/test-higgsfield/david-test.png",
  );
  console.log("SUCCESS:", JSON.stringify(result));
} catch (e) {
  console.error("FAILED:", (e as Error).message);
}
