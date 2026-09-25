#!/usr/bin/env bash
#
# Owner-held credentials for the Kiero Convex deployments.
#
# Walks the owner through the values provision-runtime.mjs cannot generate
# (DeepSeek, OpenRouter, Resend, Google OAuth, Axiom, GM addresses). Each
# value goes straight to `convex env set` over stdin: never to a file, never
# echoed. Deployment names come from provision-runtime.mjs, so a recreated
# environment is edited in one place.
#
# Run from the repo root: bash infra/environments/owner-credentials.sh

set -euo pipefail

# ── UX helpers (from the /wizard template, trimmed to what the stages use) ──

if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
  BOLD=$(tput bold); DIM=$(tput dim); RESET=$(tput sgr0)
  BLUE=$(tput setaf 4); GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3)
else
  BOLD=""; DIM=""; RESET=""; BLUE=""; GREEN=""; YELLOW=""
fi

TOTAL_STAGES=8
_STAGE_INDEX=0
SET_ON=()   # "NAME@deployment" written this run
SKIPPED=()  # what still needs doing by hand

_clear() {
  [[ -t 1 ]] || return 0
  if command -v tput >/dev/null 2>&1; then tput clear; else printf '\033[2J\033[3J\033[H'; fi
}
stage() {
  _clear
  _STAGE_INDEX=$((_STAGE_INDEX + 1))
  printf '\n%s%s▸ Stage %s/%s · %s%s\n' "$BOLD" "$BLUE" "$_STAGE_INDEX" "$TOTAL_STAGES" "$1" "$RESET"
}
say()  { printf '  %s\n' "$1"; }
step() { printf '  %s•%s %s\n' "$BLUE" "$RESET" "$1"; }
note() { printf '  %s%s%s\n' "$DIM" "$1" "$RESET"; }
warn() { printf '  %s⚠ %s%s\n' "$YELLOW" "$1" "$RESET"; }
open_url() {
  local url="$1"
  printf '  %s↗ opening%s %s\n' "$GREEN" "$RESET" "$url"
  { if   command -v wslview      >/dev/null 2>&1; then wslview "$url"
    elif command -v explorer.exe >/dev/null 2>&1; then explorer.exe "$url"
    elif command -v xdg-open     >/dev/null 2>&1; then xdg-open "$url"
    elif command -v open         >/dev/null 2>&1; then open "$url"
    else warn "couldn't open a browser; visit it manually: $url"; fi
  } >/dev/null 2>&1 || warn "couldn't open a browser; visit it manually: $url"
}
pause() { printf '  %s%s%s ' "$DIM" "${1:-Press Enter to continue}" "$RESET"; read -r _ || true; }
confirm() {
  local reply=""
  printf '  %s? %s [y/N] ' "$YELLOW" "$1"
  read -r reply || true
  [[ "$reply" =~ ^[Yy] ]]
}
# read_value VAR "prompt" secret|plain: no defaults from any local file.
read_value() {
  local input=""
  printf '  %s%s%s ' "$BOLD" "$2" "$RESET"
  if [[ "$3" == "secret" ]]; then read -rs input || true; printf '\n'; else read -r input || true; fi
  printf -v "$1" '%s' "$input"
}

# ── Deployments (single source: provision-runtime.mjs) ──────────────────────

target_field() {
  node --input-type=module -e \
    "const { TARGETS } = await import('./infra/environments/provision-runtime.mjs'); console.log(TARGETS['$1']['$2']);"
}
STAGING=$(target_field staging deployment)
DEV=$(target_field dev deployment)
STAGING_SITE=$(target_field staging site)
CONVEX=(npx --yes convex@1.45.0)
INCLUDE_DEV=false

# targets_for SCOPE: "all" = staging (+ dev when chosen), "staging" = staging only.
targets_for() {
  printf '%s\n' "$STAGING"
  if [[ "$1" == "all" && "$INCLUDE_DEV" == true ]]; then printf '%s\n' "$DEV"; fi
}

present() {
  "${CONVEX[@]}" env list --names-only --deployment "$2" 2>/dev/null | grep -qx "$1"
}

# credential NAME SCOPE "prompt" secret|plain: asks (or keeps) and writes one
# value to exactly the deployments of its scope.
credential() {
  local name="$1" scope="$2" prompt="$3" kind="$4" value target all_present=true
  local -a targets=()
  while IFS= read -r target; do targets+=("$target"); done < <(targets_for "$scope")
  for target in "${targets[@]}"; do present "$name" "$target" || all_present=false; done
  if [[ "$all_present" == true ]] && confirm "$name is already set on ${targets[*]}. Keep it?"; then
    note "kept $name"
    return
  fi
  read_value value "$prompt" "$kind"
  if [[ -z "$value" ]]; then
    SKIPPED+=("$name (no value entered)")
    warn "no value for $name; skipped"
    return
  fi
  for target in "${targets[@]}"; do
    if printf '%s' "$value" | "${CONVEX[@]}" env set "$name" --deployment "$target" >/dev/null 2>&1; then
      SET_ON+=("$name@$target")
      printf '  %s✓ set%s %s on %s\n' "$GREEN" "$RESET" "$name" "$target"
    else
      SKIPPED+=("$name on $target (convex env set failed; is the CLI logged in?)")
      warn "could not set $name on $target"
    fi
  done
  # The release injects the Axiom token into the Workers from this secret.
  if [[ "$name" == "AXIOM_API_TOKEN" ]]; then
    if printf '%s' "$value" | gh secret set STAGING_AXIOM_API_TOKEN --env staging >/dev/null 2>&1; then
      SET_ON+=("STAGING_AXIOM_API_TOKEN@github-staging")
      printf '  %s✓ set%s GitHub staging secret STAGING_AXIOM_API_TOKEN\n' "$GREEN" "$RESET"
    else
      SKIPPED+=("GitHub staging secret STAGING_AXIOM_API_TOKEN (gh secret set STAGING_AXIOM_API_TOKEN --env staging)")
    fi
  fi
}

# ── Stages ──────────────────────────────────────────────────────────────────

_clear
printf '\n%s%s  Kiero: owner credentials for Convex%s\n' "$BOLD" "$BLUE" "$RESET"
printf '%s  %s stages. Secrets are typed hidden; IDs and addresses are visible.\n' "$DIM" "$TOTAL_STAGES"
printf '  Re-running is safe: existing values can be kept.%s\n\n' "$RESET"
pause "Ready to start?"

stage "Targets and tools"
say "Staging always gets these values. Dev is optional: AI keys there mean"
say "local experiments spend real tokens."
if "${CONVEX[@]}" env list --names-only --deployment "$STAGING" >/dev/null 2>&1; then
  note "Convex CLI can read staging ($STAGING)."
else
  warn "The Convex CLI cannot read staging. Run: npx --yes convex@1.45.0 login"
  pause "Press Enter after logging in"
fi
gh auth status >/dev/null 2>&1 || warn "gh is not logged in; the Axiom GitHub secret will be skipped."
if confirm "Also set DeepSeek, OpenRouter, Resend and GM values on dev ($DEV)?"; then INCLUDE_DEV=true; fi
pause

stage "DeepSeek (chat and vision)"
open_url "https://platform.deepseek.com/api_keys"
step "Create API key → name it 'kiero' → copy the key (shown once)."
credential DEEPSEEK_API_KEY all "Paste the DeepSeek API key:" secret
pause

stage "OpenRouter (transcription, embeddings, fallback)"
open_url "https://openrouter.ai/settings/keys"
step "Create Key → name it 'kiero' → optionally set a credit limit → copy."
credential OPENROUTER_API_KEY all "Paste the OpenRouter API key:" secret
pause

stage "Resend (sign-in codes and invitations)"
open_url "https://resend.com/api-keys"
step "Create API Key → permission 'Sending access' → copy."
credential RESEND_API_KEY all "Paste the Resend API key:" secret
say ""
say "Sender: a verified-domain sender such as 'Kiero <kiero@your-domain>'."
note "Enter nothing to keep the Resend sandbox sender (delivers only to your own address)."
credential RESEND_FROM all "Sender (Name <address>):" plain
pause

stage "Google sign-in (staging OAuth client)"
say "The OAuth client must allow the current staging callback addresses."
open_url "https://console.cloud.google.com/apis/credentials?project=kiero-508611"
step "OAuth 2.0 Client IDs → open the staging web client."
step "Authorized redirect URIs → add both, then Save:"
note "  $STAGING_SITE/api/auth/callback/google"
note "  $STAGING_SITE/calendar/oauth/callback"
step "Copy the Client ID. For the secret, copy an existing one or 'Add secret'."
credential AUTH_GOOGLE_ID staging "Paste the Client ID:" plain
credential AUTH_GOOGLE_SECRET staging "Paste the Client secret:" secret
pause

stage "Axiom (diagnostics)"
open_url "https://app.axiom.co/"
step "Settings → API tokens → New token → ingest-only on dataset 'kiero-staging' → copy."
credential AXIOM_API_TOKEN staging "Paste the Axiom ingest token:" secret
pause

stage "GM operators"
say "Addresses allowed to enter the audited GM mode (comma-separated)."
credential KIERO_GM_EMAILS all "GM email address(es):" plain
pause

stage "Verify"
step "Owner-provided variables still missing (names only):"
for target in staging $([[ "$INCLUDE_DEV" == true ]] && echo dev); do
  if report=$(node infra/environments/provision-runtime.mjs --target "$target" 2>&1); then
    printf '%s\n' "$report" | grep -E "^owner-provided" | sed "s/^/  $target: /"
  else
    warn "the dry run for $target failed:"
    printf '%s\n' "$report" | tail -3 | sed 's/^/    /'
  fi
done
if [[ " ${SET_ON[*]-} " == *" STAGING_AXIOM_API_TOKEN@github-staging "* ]]; then
  say ""
  warn "Workers read the Axiom token only after a release:"
  note "  gh workflow run release.yml --ref main -f target=staging -f notes='Axiom token'"
fi
pause

_clear
printf '\n%s%s  ✓ Done%s\n' "$BOLD" "$GREEN" "$RESET"
if (( ${#SET_ON[@]} )); then note "set ${#SET_ON[@]} value(s): ${SET_ON[*]}"; fi
if (( ${#SKIPPED[@]} )); then
  printf '\n'; warn "still to do by hand:"
  for s in "${SKIPPED[@]}"; do note "  - $s"; done
fi
printf '\n'
