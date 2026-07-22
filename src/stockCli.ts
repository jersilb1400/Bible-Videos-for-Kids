import { assembleFromStockClips } from "./stages/stockAssembly.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const manifestPath = arg("manifest");
  if (!manifestPath) {
    console.log(`Stock Clip Assembly — stitch licensed/downloaded footage with narration + music.

Usage:
  npm run stock -- --manifest path/to/manifest.json
  npm run stock -- --manifest path/to/manifest.json --no-captions

Manifest schema: see src/stages/stockAssembly.ts (StockManifestSchema) or
scripts/stock-manifest.example.json for a working template.`);
    process.exit(manifestPath ? 0 : 1);
  }

  const noCaptions = process.argv.includes("--no-captions");
  try {
    const final = await assembleFromStockClips({ manifestPath, captions: !noCaptions });
    console.log(`\n✓ ${final}`);
  } catch (e) {
    console.error(`\n✗ Stock assembly failed: ${(e as Error).message}`);
    process.exit(1);
  }
}

main();
