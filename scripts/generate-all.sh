#!/bin/bash
# Generate all 9 Bible story episodes sequentially (offline mode, no API keys needed)
set -e
cd "/Users/jeremysilbernagel/Documents/Jeremy Apps/Bible-Videos-for-Kids"
export OPENROUTER_API_KEY=

TOPICS=(
  "Noah's Ark"
  "David and Goliath"
  "Jonah and the Whale"
  "The Good Samaritan"
  "Creation"
  "Baby Moses"
  "Jesus Feeds 5000"
  "Joseph's Colorful Coat"
  "Joshua and Jericho"
)

PASS=0
FAIL=0

for topic in "${TOPICS[@]}"; do
  echo ""
  echo "═══════════════ ${topic} ═══════════════"
  if npm run run -- --topic "$topic" --no-publish 2>&1 | tee /tmp/episode-out.txt | tail -5; then
    if grep -q "Final episode:" /tmp/episode-out.txt; then
      echo "✅ PASS: $topic"
      ((PASS++))
    else
      echo "⚠️  WARN: $topic ran but no Final episode found"
      ((FAIL++))
    fi
  else
    echo "❌ FAIL: $topic (exit code non-zero)"
    ((FAIL++))
  fi
done

echo ""
echo "═══════════════════════════════════════"
echo "Results: $PASS passed, $FAIL failed"
