#!/usr/bin/env bash
set -euo pipefail

if ls n8n-workflows/*.json >/dev/null 2>&1; then
  for file in n8n-workflows/*.json; do
    echo "Validating $file"
    python -m json.tool "$file" >/dev/null
  done
else
  echo "No workflow JSON files found."
fi
