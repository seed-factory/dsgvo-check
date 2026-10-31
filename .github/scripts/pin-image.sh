#!/usr/bin/env bash
# Pins the scanner image of a release by digest (D24: image → digest → commit in action.yml → tag).
# Rewrites the `image` default of action.yml and DSGVO_CHECK_IMAGE of the GitLab template; nothing else changes.
#
#   .github/scripts/pin-image.sh ghcr.io/seed-factory/dsgvo-check@sha256:<64 hex> [repository root]
#
# Used by .github/workflows/release.yml; tested by test/e2e/delivery-config.e2e.test.ts.
set -euo pipefail

ref="${1:?usage: pin-image.sh <image@sha256:digest> [root]}"
root="${2:-.}"

if [[ ! "$ref" =~ ^ghcr\.io/seed-factory/dsgvo-check@sha256:[0-9a-f]{64}$ ]]; then
  echo "pin-image: not a digest reference of ghcr.io/seed-factory/dsgvo-check: $ref" >&2
  exit 1
fi

# Replace the single line of $1 that starts with $2 by $3; fail (file unchanged) unless exactly one line matches.
pin() {
  local file="$1" prefix="$2" line="$3" tmp
  tmp="$(mktemp)"
  if ! awk -v prefix="$prefix" -v line="$line" '
    index($0, prefix) == 1 { print line; n++; next }
    { print }
    END { exit n == 1 ? 0 : 1 }
  ' "$file" > "$tmp"; then
    rm -f "$tmp"
    echo "pin-image: expected exactly one line starting with '$prefix' in $file" >&2
    exit 1
  fi
  cat "$tmp" > "$file"
  rm -f "$tmp"
}

action="$root/action.yml"
template="$root/templates/gitlab/dsgvo-check.gitlab-ci.yml"
[[ -f "$action" && -f "$template" ]] || { echo "pin-image: action.yml or the GitLab template not found under $root" >&2; exit 1; }

# Check both files before writing either, so a failure leaves the tree unchanged.
for f in "$action" "$template"; do cp -- "$f" "$f.pin-check"; done
trap 'rm -f -- "$action.pin-check" "$template.pin-check"' EXIT
pin "$action.pin-check" "    default: ghcr.io/seed-factory/dsgvo-check" "    default: $ref"
pin "$template.pin-check" "  DSGVO_CHECK_IMAGE: " "  DSGVO_CHECK_IMAGE: $ref"
cat -- "$action.pin-check" > "$action"
cat -- "$template.pin-check" > "$template"

echo "pin-image: $ref"
