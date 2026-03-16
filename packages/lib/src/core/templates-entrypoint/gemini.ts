import type { TemplateConfig } from "../domain.js"

// CHANGE: add Gemini CLI entrypoint configuration
// WHY: enable Gemini CLI authentication and configuration management similar to Claude/Codex
// QUOTE(ТЗ): "Добавь поддержку gemini CLI"
// REF: issue-146
// SOURCE: https://geminicli.com/docs/get-started/authentication/
// FORMAT THEOREM: forall config: renderEntrypointGeminiConfig(config) -> valid_bash_script
// PURITY: CORE
// EFFECT: n/a
// INVARIANT: GEMINI_API_KEY is loaded from shared auth volume
// COMPLEXITY: O(1)

const geminiAuthRootContainerPath = (sshUser: string): string => `/home/${sshUser}/.docker-git/.orch/auth/gemini`

const geminiAuthConfigTemplate = String
  .raw`# Gemini CLI: expose GEMINI_API_KEY for SSH sessions (API key stored under ~/.docker-git/.orch/auth/gemini)
GEMINI_LABEL_RAW="${"$"}{GEMINI_AUTH_LABEL:-}"
if [[ -z "$GEMINI_LABEL_RAW" ]]; then
  GEMINI_LABEL_RAW="default"
fi

GEMINI_LABEL_NORM="$(printf "%s" "$GEMINI_LABEL_RAW" \
  | tr '[:upper:]' '[:lower:]' \
  | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')"
if [[ -z "$GEMINI_LABEL_NORM" ]]; then
  GEMINI_LABEL_NORM="default"
fi

GEMINI_AUTH_ROOT="__GEMINI_AUTH_ROOT__"
GEMINI_AUTH_DIR="$GEMINI_AUTH_ROOT/$GEMINI_LABEL_NORM"

# Backward compatibility: if default auth is stored directly under gemini root, reuse it.
if [[ "$GEMINI_LABEL_NORM" == "default" ]]; then
  GEMINI_ROOT_ENV_FILE="$GEMINI_AUTH_ROOT/.env"
  if [[ -f "$GEMINI_ROOT_ENV_FILE" ]]; then
    GEMINI_AUTH_DIR="$GEMINI_AUTH_ROOT"
  fi
fi

mkdir -p "$GEMINI_AUTH_DIR" || true
GEMINI_HOME_DIR="__GEMINI_HOME_DIR__"
mkdir -p "$GEMINI_HOME_DIR" || true

GEMINI_API_KEY_FILE="$GEMINI_AUTH_DIR/.api-key"
GEMINI_ENV_FILE="$GEMINI_AUTH_DIR/.env"
GEMINI_HOME_ENV_FILE="$GEMINI_HOME_DIR/.env"

docker_git_link_gemini_file() {
  local source_path="$1"
  local link_path="$2"

  # Preserve user-created regular files and seed config dir once.
  if [[ -e "$link_path" && ! -L "$link_path" ]]; then
    if [[ -f "$link_path" && ! -e "$source_path" ]]; then
      cp "$link_path" "$source_path" || true
      chmod 0600 "$source_path" || true
    fi
    return 0
  fi

  ln -sfn "$source_path" "$link_path" || true
}

# Link Gemini .env file from auth dir to home dir
docker_git_link_gemini_file "$GEMINI_ENV_FILE" "$GEMINI_HOME_ENV_FILE"

docker_git_refresh_gemini_api_key() {
  local api_key=""
  # Try to read from dedicated API key file first
  if [[ -f "$GEMINI_API_KEY_FILE" ]]; then
    api_key="$(tr -d '\r\n' < "$GEMINI_API_KEY_FILE")"
  fi
  # Fall back to .env file
  if [[ -z "$api_key" && -f "$GEMINI_ENV_FILE" ]]; then
    api_key="$(grep -E '^GEMINI_API_KEY=' "$GEMINI_ENV_FILE" 2>/dev/null | head -1 | cut -d'=' -f2- | tr -d '\r\n' | sed "s/^['\"]//;s/['\"]$//")"
  fi
  if [[ -n "$api_key" ]]; then
    export GEMINI_API_KEY="$api_key"
  else
    unset GEMINI_API_KEY || true
  fi
}

docker_git_refresh_gemini_api_key`

const renderGeminiAuthConfig = (config: TemplateConfig): string =>
  geminiAuthConfigTemplate
    .replaceAll("__GEMINI_AUTH_ROOT__", geminiAuthRootContainerPath(config.sshUser))
    .replaceAll("__GEMINI_HOME_DIR__", `/home/${config.sshUser}/.gemini`)

const renderGeminiCliInstall = (): string =>
  String.raw`# Gemini CLI: ensure CLI command exists (non-blocking startup self-heal)
docker_git_ensure_gemini_cli() {
  if command -v gemini >/dev/null 2>&1; then
    return 0
  fi

  if ! command -v npm >/dev/null 2>&1; then
    return 0
  fi

  NPM_ROOT="$(npm root -g 2>/dev/null || true)"
  GEMINI_CLI_JS="$NPM_ROOT/@google/gemini-cli/build/cli.js"
  if [[ -z "$NPM_ROOT" || ! -f "$GEMINI_CLI_JS" ]]; then
    echo "docker-git: gemini cli.js not found under npm global root; skip shim restore" >&2
    return 0
  fi

  # Rebuild a minimal shim when npm package exists but binary link is missing.
  cat <<'EOF' > /usr/local/bin/gemini
#!/usr/bin/env bash
set -euo pipefail

if ! command -v npm >/dev/null 2>&1; then
  echo "gemini: npm is required but missing" >&2
  exit 127
fi

NPM_ROOT="$(npm root -g 2>/dev/null || true)"
GEMINI_CLI_JS="$NPM_ROOT/@google/gemini-cli/build/cli.js"
if [[ -z "$NPM_ROOT" || ! -f "$GEMINI_CLI_JS" ]]; then
  echo "gemini: cli.js not found under npm global root" >&2
  exit 127
fi

exec node "$GEMINI_CLI_JS" "$@"
EOF
  chmod 0755 /usr/local/bin/gemini || true
  ln -sf /usr/local/bin/gemini /usr/bin/gemini || true
}

docker_git_ensure_gemini_cli`

const renderGeminiProfileSetup = (): string =>
  String.raw`GEMINI_PROFILE="/etc/profile.d/gemini-config.sh"
printf "export GEMINI_AUTH_LABEL=%q\n" "${"$"}{GEMINI_AUTH_LABEL:-default}" > "$GEMINI_PROFILE"
cat <<'EOF' >> "$GEMINI_PROFILE"
GEMINI_API_KEY_FILE="${"$"}{GEMINI_AUTH_DIR:-$HOME/.gemini}/.api-key"
GEMINI_ENV_FILE="${"$"}{GEMINI_AUTH_DIR:-$HOME/.gemini}/.env"
if [[ -f "$GEMINI_API_KEY_FILE" ]]; then
  export GEMINI_API_KEY="$(tr -d '\r\n' < "$GEMINI_API_KEY_FILE")"
elif [[ -f "$GEMINI_ENV_FILE" ]]; then
  GEMINI_KEY="$(grep -E '^GEMINI_API_KEY=' "$GEMINI_ENV_FILE" 2>/dev/null | head -1 | cut -d'=' -f2- | tr -d '\r\n' | sed "s/^['\"]//;s/['\"]$//")"
  if [[ -n "$GEMINI_KEY" ]]; then
    export GEMINI_API_KEY="$GEMINI_KEY"
  fi
fi
EOF
chmod 0644 "$GEMINI_PROFILE" || true

docker_git_upsert_ssh_env "GEMINI_AUTH_LABEL" "${"$"}{GEMINI_AUTH_LABEL:-default}"
docker_git_upsert_ssh_env "GEMINI_API_KEY" "${"$"}{GEMINI_API_KEY:-}"`

export const renderEntrypointGeminiConfig = (config: TemplateConfig): string =>
  [
    renderGeminiAuthConfig(config),
    renderGeminiCliInstall(),
    renderGeminiProfileSetup()
  ].join("\n\n")
