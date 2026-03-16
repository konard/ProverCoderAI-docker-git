import type * as CommandExecutor from "@effect/platform/CommandExecutor"
import type { PlatformError } from "@effect/platform/Error"
import type * as FileSystem from "@effect/platform/FileSystem"
import type * as Path from "@effect/platform/Path"
import { Effect, pipe } from "effect"

import type { AuthGeminiLoginCommand, AuthGeminiLogoutCommand, AuthGeminiStatusCommand } from "../core/domain.js"
import { defaultTemplateConfig } from "../core/domain.js"
import { runCommandExitCode } from "../shell/command-runner.js"
import type { AuthError, CommandFailedError } from "../shell/errors.js"
import { runGeminiOauthLoginWithPrompt } from "./auth-gemini-oauth.js"
import { isRegularFile, normalizeAccountLabel } from "./auth-helpers.js"
import { migrateLegacyOrchLayout } from "./auth-sync.js"
import { ensureDockerImage } from "./docker-image.js"
import { resolvePathFromCwd } from "./path-helpers.js"
import { withFsPathContext } from "./runtime.js"
import { autoSyncState } from "./state-repo.js"

// CHANGE: add Gemini CLI authentication management with OAuth and API key support
// WHY: enable Gemini CLI authentication via API key or OAuth (for headless/Docker environments)
// QUOTE(ТЗ): "Добавь поддержку gemini CLI", "Типо ждал пока мы вставим ссылку"
// REF: issue-146, PR-147 comment from skulidropek
// SOURCE: https://geminicli.com/docs/get-started/authentication/
// FORMAT THEOREM: forall cmd: authGeminiLogin(cmd) -> (api_key_persisted | oauth_completed) | error
// PURITY: SHELL
// EFFECT: Effect<void, PlatformError | CommandFailedError | AuthError, GeminiRuntime>
// INVARIANT: Credentials are stored in isolated account directory
// COMPLEXITY: O(1) for API key, O(user_interaction) for OAuth

type GeminiRuntime = FileSystem.FileSystem | Path.Path | CommandExecutor.CommandExecutor
type GeminiAuthMethod = "none" | "api-key" | "oauth"

const geminiImageName = "docker-git-auth-gemini:latest"
const geminiImageDir = ".docker-git/.orch/auth/gemini/.image"
const geminiContainerHomeDir = "/gemini-home"
const geminiCredentialsDir = ".gemini"

type GeminiAccountContext = {
  readonly accountLabel: string
  readonly accountPath: string
  readonly cwd: string
  readonly fs: FileSystem.FileSystem
}

export const geminiAuthRoot = ".docker-git/.orch/auth/gemini"

const geminiApiKeyFileName = ".api-key"
const geminiEnvFileName = ".env"

const geminiApiKeyPath = (accountPath: string): string => `${accountPath}/${geminiApiKeyFileName}`
const geminiEnvFilePath = (accountPath: string): string => `${accountPath}/${geminiEnvFileName}`
const geminiCredentialsPath = (accountPath: string): string => `${accountPath}/${geminiCredentialsDir}`

// CHANGE: render Dockerfile for Gemini CLI authentication image
// WHY: Gemini CLI OAuth requires running in Docker for headless environments
// QUOTE(ТЗ): "Типо ждал пока мы вставим ссылку"
// REF: issue-146, PR-147 comment
// SOURCE: https://github.com/google-gemini/gemini-cli
// FORMAT THEOREM: renderGeminiDockerfile() -> valid_dockerfile
// PURITY: CORE
// INVARIANT: Image includes Node.js and Gemini CLI
// COMPLEXITY: O(1)
const renderGeminiDockerfile = (): string =>
  String.raw`FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl bsdutils \
  && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && node -v \
  && npm -v \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g @google/gemini-cli@latest
ENTRYPOINT ["/bin/bash", "-c"]
`

const ensureGeminiOrchLayout = (
  cwd: string
): Effect.Effect<void, PlatformError, FileSystem.FileSystem | Path.Path> =>
  migrateLegacyOrchLayout(cwd, {
    envGlobalPath: defaultTemplateConfig.envGlobalPath,
    envProjectPath: defaultTemplateConfig.envProjectPath,
    codexAuthPath: defaultTemplateConfig.codexAuthPath,
    ghAuthPath: ".docker-git/.orch/auth/gh",
    claudeAuthPath: ".docker-git/.orch/auth/claude",
    geminiAuthPath: ".docker-git/.orch/auth/gemini"
  })

const resolveGeminiAccountPath = (path: Path.Path, rootPath: string, label: string | null): {
  readonly accountLabel: string
  readonly accountPath: string
} => {
  const accountLabel = normalizeAccountLabel(label, "default")
  const accountPath = path.join(rootPath, accountLabel)
  return { accountLabel, accountPath }
}

const withGeminiAuth = <A, E>(
  command: AuthGeminiLoginCommand | AuthGeminiLogoutCommand | AuthGeminiStatusCommand,
  run: (
    context: GeminiAccountContext
  ) => Effect.Effect<A, E, CommandExecutor.CommandExecutor>,
  options: { readonly buildImage?: boolean } = {}
): Effect.Effect<A, E | PlatformError | CommandFailedError, GeminiRuntime> =>
  withFsPathContext(({ cwd, fs, path }) =>
    Effect.gen(function*(_) {
      yield* _(ensureGeminiOrchLayout(cwd))
      const rootPath = resolvePathFromCwd(path, cwd, command.geminiAuthPath)
      const { accountLabel, accountPath } = resolveGeminiAccountPath(path, rootPath, command.label)
      yield* _(fs.makeDirectory(accountPath, { recursive: true }))
      if (options.buildImage === true) {
        yield* _(
          ensureDockerImage(fs, path, cwd, {
            imageName: geminiImageName,
            imageDir: geminiImageDir,
            dockerfile: renderGeminiDockerfile(),
            buildLabel: "gemini auth"
          })
        )
      }
      return yield* _(run({ accountLabel, accountPath, cwd, fs }))
    })
  )

const readApiKey = (
  fs: FileSystem.FileSystem,
  accountPath: string
): Effect.Effect<string | null, PlatformError> =>
  Effect.gen(function*(_) {
    const apiKeyFilePath = geminiApiKeyPath(accountPath)
    const hasApiKey = yield* _(isRegularFile(fs, apiKeyFilePath))
    if (hasApiKey) {
      const apiKey = yield* _(fs.readFileString(apiKeyFilePath), Effect.orElseSucceed(() => ""))
      const trimmed = apiKey.trim()
      if (trimmed.length > 0) {
        return trimmed
      }
    }

    const envFilePath = geminiEnvFilePath(accountPath)
    const hasEnvFile = yield* _(isRegularFile(fs, envFilePath))
    if (hasEnvFile) {
      const envContent = yield* _(fs.readFileString(envFilePath), Effect.orElseSucceed(() => ""))
      const lines = envContent.split("\n")
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed.startsWith("GEMINI_API_KEY=")) {
          const value = trimmed.slice("GEMINI_API_KEY=".length).replaceAll(/^['"]|['"]$/g, "").trim()
          if (value.length > 0) {
            return value
          }
        }
      }
    }

    return null
  })

// CHANGE: check for OAuth credentials in .gemini directory
// WHY: Gemini CLI stores OAuth tokens in ~/.gemini after successful OAuth flow
// QUOTE(ТЗ): "Типо ждал пока мы вставим ссылку"
// REF: issue-146, PR-147 comment
// SOURCE: https://github.com/google-gemini/gemini-cli
// FORMAT THEOREM: hasOauthCredentials(fs, accountPath) -> boolean
// PURITY: SHELL
// INVARIANT: checks for existence of OAuth token file
// COMPLEXITY: O(1)
const hasOauthCredentials = (
  fs: FileSystem.FileSystem,
  accountPath: string
): Effect.Effect<boolean, PlatformError> =>
  Effect.gen(function*(_) {
    const credentialsDir = geminiCredentialsPath(accountPath)
    const dirExists = yield* _(fs.exists(credentialsDir))
    if (!dirExists) {
      return false
    }
    // Check for various possible credential files Gemini CLI might create
    const possibleFiles = [
      `${credentialsDir}/oauth-tokens.json`,
      `${credentialsDir}/credentials.json`,
      `${credentialsDir}/application_default_credentials.json`
    ]
    for (const filePath of possibleFiles) {
      const fileExists = yield* _(isRegularFile(fs, filePath))
      if (fileExists) {
        return true
      }
    }
    return false
  })

// CHANGE: resolve Gemini authentication method
// WHY: need to detect whether user authenticated via API key or OAuth
// QUOTE(ТЗ): "Добавь поддержку gemini CLI"
// REF: issue-146
// SOURCE: https://geminicli.com/docs/get-started/authentication/
// FORMAT THEOREM: resolveGeminiAuthMethod(fs, accountPath) -> GeminiAuthMethod
// PURITY: SHELL
// INVARIANT: API key takes precedence over OAuth credentials
// COMPLEXITY: O(1)
const resolveGeminiAuthMethod = (
  fs: FileSystem.FileSystem,
  accountPath: string
): Effect.Effect<GeminiAuthMethod, PlatformError> =>
  Effect.gen(function*(_) {
    const apiKey = yield* _(readApiKey(fs, accountPath))
    if (apiKey !== null) {
      return "api-key"
    }

    const hasOauth = yield* _(hasOauthCredentials(fs, accountPath))
    return hasOauth ? "oauth" : "none"
  })

// CHANGE: login to Gemini CLI by storing API key (menu version with direct key)
// WHY: Gemini CLI uses GEMINI_API_KEY environment variable for authentication
// QUOTE(ТЗ): "Добавь поддержку gemini CLI"
// REF: issue-146
// SOURCE: https://geminicli.com/docs/get-started/authentication/
// FORMAT THEOREM: forall cmd: authGeminiLogin(cmd) -> api_key_file_exists(accountPath)
// PURITY: SHELL
// EFFECT: Effect<void, PlatformError | CommandFailedError, GeminiRuntime>
// INVARIANT: API key is stored in .api-key file with 0600 permissions
// COMPLEXITY: O(1)
export const authGeminiLogin = (
  command: AuthGeminiLoginCommand,
  apiKey: string
): Effect.Effect<void, PlatformError | CommandFailedError, GeminiRuntime> => {
  const accountLabel = normalizeAccountLabel(command.label, "default")
  return withGeminiAuth(command, ({ accountPath, fs }) =>
    Effect.gen(function*(_) {
      const apiKeyFilePath = geminiApiKeyPath(accountPath)
      yield* _(fs.writeFileString(apiKeyFilePath, `${apiKey.trim()}\n`))
      yield* _(fs.chmod(apiKeyFilePath, 0o600), Effect.orElseSucceed(() => void 0))
    })).pipe(
      Effect.zipRight(autoSyncState(`chore(state): auth gemini ${accountLabel}`))
    )
}

// CHANGE: login to Gemini CLI via CLI (prompts user to run web-based setup)
// WHY: CLI-based login requires interactive API key entry
// QUOTE(ТЗ): "Добавь поддержку gemini CLI"
// REF: issue-146
// SOURCE: https://geminicli.com/docs/get-started/authentication/
// FORMAT THEOREM: forall cmd: authGeminiLoginCli(cmd) -> instruction_shown
// PURITY: SHELL
// EFFECT: Effect<void, PlatformError | CommandFailedError, GeminiRuntime>
// INVARIANT: only shows instructions, does not store credentials
// COMPLEXITY: O(1)
export const authGeminiLoginCli = (
  _command: AuthGeminiLoginCommand
): Effect.Effect<void, PlatformError | CommandFailedError, GeminiRuntime> =>
  Effect.gen(function*(_) {
    yield* _(Effect.log("Gemini CLI supports two authentication methods:"))
    yield* _(Effect.log(""))
    yield* _(Effect.log("1. API Key (recommended for simplicity):"))
    yield* _(Effect.log("   - Go to https://ai.google.dev/aistudio"))
    yield* _(Effect.log("   - Create or retrieve your API key"))
    yield* _(Effect.log("   - Use: docker-git menu -> Auth profiles -> Gemini CLI: set API key"))
    yield* _(Effect.log(""))
    yield* _(Effect.log("2. OAuth (Sign in with Google):"))
    yield* _(Effect.log("   - Use: docker-git menu -> Auth profiles -> Gemini CLI: login via OAuth"))
    yield* _(Effect.log("   - Follow the prompts to authenticate with your Google account"))
  })

// CHANGE: login to Gemini CLI via OAuth in Docker container
// WHY: enable Gemini CLI OAuth authentication in headless/Docker environments
// QUOTE(ТЗ): "Мне надо что бы он её умел принимать, типо ждал пока мы вставим ссылку"
// REF: issue-146, PR-147 comment from skulidropek
// SOURCE: https://github.com/google-gemini/gemini-cli
const prepareGeminiCredentialsDir = (
  cwd: string,
  accountPath: string,
  fs: FileSystem.FileSystem
) =>
  Effect.gen(function*(_) {
    const credentialsDir = geminiCredentialsPath(accountPath)
    const removeFallback = pipe(
      runCommandExitCode({
        cwd,
        command: "docker",
        args: ["run", "--rm", "-v", `${accountPath}:/target`, "alpine", "rm", "-rf", "/target/.gemini"]
      }),
      Effect.asVoid,
      Effect.orElse(() => Effect.void)
    )

    yield* _(
      fs.remove(credentialsDir, { recursive: true, force: true }).pipe(
        Effect.orElse(() => removeFallback)
      )
    )
    yield* _(fs.makeDirectory(credentialsDir, { recursive: true }))
    return credentialsDir
  })

const writeInitialSettings = (credentialsDir: string, fs: FileSystem.FileSystem) =>
  Effect.gen(function*(_) {
    const settingsPath = `${credentialsDir}/settings.json`
    yield* _(fs.writeFileString(settingsPath, JSON.stringify({ security: { folderTrust: { enabled: false } } })))

    const trustedFoldersPath = `${credentialsDir}/trustedFolders.json`
    yield* _(
      fs.writeFileString(
        trustedFoldersPath,
        JSON.stringify({ "/": "TRUST_FOLDER", [geminiContainerHomeDir]: "TRUST_FOLDER" })
      )
    )
    return settingsPath
  })

// FORMAT THEOREM: forall cmd: authGeminiLoginOauth(cmd) -> oauth_credentials_stored | error
// PURITY: SHELL
// EFFECT: Effect<void, AuthError | PlatformError | CommandFailedError, GeminiRuntime>
// INVARIANT: OAuth credentials are stored in account directory after successful auth
// COMPLEXITY: O(user_interaction)
export const authGeminiLoginOauth = (
  command: AuthGeminiLoginCommand
): Effect.Effect<void, AuthError | PlatformError | CommandFailedError, GeminiRuntime> => {
  const accountLabel = normalizeAccountLabel(command.label, "default")
  return withGeminiAuth(
    command,
    ({ accountPath, cwd, fs }) =>
      Effect.gen(function*(_) {
        const credentialsDir = yield* _(prepareGeminiCredentialsDir(cwd, accountPath, fs))
        const settingsPath = yield* _(writeInitialSettings(credentialsDir, fs))

        yield* _(
          runGeminiOauthLoginWithPrompt(cwd, accountPath, {
            image: geminiImageName,
            containerPath: geminiContainerHomeDir
          })
        )

        // Generate complete settings.json on the host so containers don't have to guess
        yield* _(
          fs.writeFileString(
            settingsPath,
            JSON.stringify(
              {
                security: {
                  folderTrust: { enabled: false },
                  auth: { selectedType: "oauth-personal" },
                  approvalPolicy: "never"
                }
              },
              null,
              2
            ) + "\n"
          )
        )
      }),
    { buildImage: true }
  ).pipe(
    Effect.zipRight(autoSyncState(`chore(state): auth gemini oauth ${accountLabel}`))
  )
}

// CHANGE: show Gemini CLI auth status for a given label
// WHY: allow verifying API key/OAuth presence without exposing credentials
// QUOTE(ТЗ): "Добавь поддержку gemini CLI"
// REF: issue-146
// SOURCE: https://geminicli.com/docs/get-started/authentication/
// FORMAT THEOREM: forall cmd: authGeminiStatus(cmd) -> connected(cmd, method) | disconnected(cmd)
// PURITY: SHELL
// EFFECT: Effect<void, PlatformError | CommandFailedError, GeminiRuntime>
// INVARIANT: never logs API keys or OAuth tokens
// COMPLEXITY: O(1)
export const authGeminiStatus = (
  command: AuthGeminiStatusCommand
): Effect.Effect<void, PlatformError | CommandFailedError, GeminiRuntime> =>
  withGeminiAuth(command, ({ accountLabel, accountPath, fs }) =>
    Effect.gen(function*(_) {
      const authMethod = yield* _(resolveGeminiAuthMethod(fs, accountPath))
      if (authMethod === "none") {
        yield* _(Effect.log(`Gemini not connected (${accountLabel}).`))
        return
      }
      yield* _(Effect.log(`Gemini connected (${accountLabel}, ${authMethod}).`))
    }))

// CHANGE: logout Gemini CLI by clearing API key and OAuth credentials for a label
// WHY: allow revoking Gemini CLI access deterministically
// QUOTE(ТЗ): "Добавь поддержку gemini CLI"
// REF: issue-146
// SOURCE: https://geminicli.com/docs/get-started/authentication/
// FORMAT THEOREM: forall cmd: authGeminiLogout(cmd) -> credentials_cleared(cmd)
// PURITY: SHELL
// EFFECT: Effect<void, PlatformError | CommandFailedError, GeminiRuntime>
// INVARIANT: all credential files (API key and OAuth) are removed from account directory
// COMPLEXITY: O(1)
export const authGeminiLogout = (
  command: AuthGeminiLogoutCommand
): Effect.Effect<void, PlatformError | CommandFailedError, GeminiRuntime> =>
  Effect.gen(function*(_) {
    const accountLabel = normalizeAccountLabel(command.label, "default")
    yield* _(
      withGeminiAuth(command, ({ accountPath, fs }) =>
        Effect.gen(function*(_) {
          // Clear API key
          yield* _(fs.remove(geminiApiKeyPath(accountPath), { force: true }))
          yield* _(fs.remove(geminiEnvFilePath(accountPath), { force: true }))
          // Clear OAuth credentials (entire .gemini directory)
          yield* _(fs.remove(geminiCredentialsPath(accountPath), { recursive: true, force: true }))
        }))
    )
    yield* _(autoSyncState(`chore(state): auth gemini logout ${accountLabel}`))
  }).pipe(Effect.asVoid)
