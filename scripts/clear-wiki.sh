#!/usr/bin/env bash
# Clear all wiki content while keeping the directory scaffold that pi-llm-wiki expects.
# Usage: bash scripts/clear-wiki.sh

set -euo pipefail

WIKI="${WIKI_HOME:-$PWD/.semla-wiki}/.llm-wiki"

echo "Clearing wiki at: $WIKI"

# Pages
rm -rf "$WIKI"/wiki/entities/*   "$WIKI"/wiki/concepts/*   "$WIKI"/wiki/sources/* \
       "$WIKI"/wiki/analyses/*   "$WIKI"/wiki/syntheses/*  "$WIKI"/wiki/requirements/*
rm -f  "$WIKI"/wiki/index.md     "$WIKI"/wiki/log.md

# Metadata
rm -f  "$WIKI"/meta/registry.json "$WIKI"/meta/backlinks.json \
       "$WIKI"/meta/index.md      "$WIKI"/meta/log.md          "$WIKI"/meta/events.jsonl

# Raw ingested sources
rm -rf "$WIKI"/raw/sources/* "$WIKI"/raw/assets/*

# Discoveries cache
rm -f  "$WIKI"/.discoveries/*

# Ensure all expected directories still exist (pi-llm-wiki doesn't self-heal all of them)
mkdir -p \
  "$WIKI"/wiki/entities   "$WIKI"/wiki/concepts  "$WIKI"/wiki/sources \
  "$WIKI"/wiki/analyses   "$WIKI"/wiki/syntheses "$WIKI"/wiki/requirements \
  "$WIKI"/meta            "$WIKI"/raw/sources    "$WIKI"/raw/assets \
  "$WIKI"/outputs         "$WIKI"/.discoveries   "$WIKI"/templates/pages

echo "Done."
