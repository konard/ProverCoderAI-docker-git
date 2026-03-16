import * as Command from "@effect/platform/Command"
import * as CommandExecutor from "@effect/platform/CommandExecutor"
import type { PlatformError } from "@effect/platform/Error"
import { Effect, pipe } from "effect"
import * as Fiber from "effect/Fiber"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"

import { stripAnsi, writeChunkToFd } from "../shell/ansi-strip.js"
import { resolveDefaultDockerUser, resolveDockerVolumeHostPath } from "../shell/docker-auth.js"
import { AuthError, CommandFailedError } from "../shell/errors.js"

// CHANGE: add Gemini CLI OAuth authentication flow
// WHY: enable Gemini CLI OAuth login in headless/Docker environments
// QUOTE(ТЗ): "Мне надо что бы он её умел принимать, типо ждал пока мы вставим ссылку"
// REF: issue-146, PR-147 comment from skulidropek
// SOURCE: https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/code_assist/oauth2.ts
// FORMAT THEOREM: forall cmd: runGeminiOauthLogin(cmd) -> oauth_credentials_stored | error
// PURITY: SHELL
// EFFECT: Effect<void, AuthError | CommandFailedError | PlatformError, CommandExecutor>
// INVARIANT: OAuth credentials are stored in ~/.gemini directory within account path
// COMPLEXITY: O(command)

type GeminiAuthResult = "success" | "failure" | "pending"

const outputWindowSize = 262_144

// Detect successful authentication in Gemini CLI output
const authSuccessPatterns = [
  "Authentication succeeded",
  "Authentication successful",
  "Successfully authenticated",
  "Logged in as",
  "You are now logged in"
]

const authFailurePatterns = [
  "Authentication failed",
  "Failed to authenticate",
  "Authorization failed",
  "Authentication timed out",
  "Authentication cancelled"
]

const detectAuthResult = (output: string): GeminiAuthResult => {
  const normalized = stripAnsi(output).toLowerCase()

  for (const pattern of authSuccessPatterns) {
    if (normalized.includes(pattern.toLowerCase())) {
      return "success"
    }
  }

  for (const pattern of authFailurePatterns) {
    if (normalized.includes(pattern.toLowerCase())) {
      return "failure"
    }
  }

  return "pending"
}

type DockerGeminiAuthSpec = {
  readonly cwd: string
  readonly image: string
  readonly hostPath: string
  readonly containerPath: string
  readonly env: ReadonlyArray<string>
}

const buildDockerGeminiAuthSpec = (
  cwd: string,
  accountPath: string,
  image: string,
  containerPath: string
): DockerGeminiAuthSpec => ({
  cwd,
  image,
  hostPath: accountPath,
  containerPath,
  env: [
    `HOME=${containerPath}`,
    "NO_BROWSER=true",
    "GEMINI_CLI_NONINTERACTIVE=false"
  ]
})

const buildDockerGeminiAuthArgs = (spec: DockerGeminiAuthSpec): ReadonlyArray<string> => {
  const base: Array<string> = ["run", "--rm", "-i", "-t", "-v", `${spec.hostPath}:${spec.containerPath}`]
  const dockerUser = resolveDefaultDockerUser()
  if (dockerUser !== null) {
    base.push("--user", dockerUser)
  }
  for (const entry of spec.env) {
    const trimmed = entry.trim()
    if (trimmed.length === 0) {
      continue
    }
    base.push("-e", trimmed)
  }
  // Run gemini CLI - it will prompt for OAuth authentication with NO_BROWSER=true
  return [...base, spec.image, "gemini"]
}

const startDockerProcess = (
  executor: CommandExecutor.CommandExecutor,
  spec: DockerGeminiAuthSpec
): Effect.Effect<CommandExecutor.Process, PlatformError, Scope.Scope> =>
  executor.start(
    pipe(
      Command.make("docker", ...buildDockerGeminiAuthArgs(spec)),
      Command.workingDirectory(spec.cwd),
      Command.stdin("inherit"),
      Command.stdout("pipe"),
      Command.stderr("pipe")
    )
  )

const pumpDockerOutput = (
  source: Stream.Stream<Uint8Array, PlatformError>,
  fd: number,
  resultBox: { value: GeminiAuthResult }
): Effect.Effect<void, PlatformError> => {
  const decoder = new TextDecoder("utf-8")
  let outputWindow = ""

  return pipe(
    source,
    Stream.runForEach((chunk) =>
      Effect.sync(() => {
        writeChunkToFd(fd, chunk)
        outputWindow += decoder.decode(chunk)
        if (outputWindow.length > outputWindowSize) {
          outputWindow = outputWindow.slice(-outputWindowSize)
        }
        if (resultBox.value !== "pending") {
          return
        }
        const result = detectAuthResult(outputWindow)
        if (result !== "pending") {
          resultBox.value = result
        }
      }).pipe(Effect.asVoid)
    )
  ).pipe(Effect.asVoid)
}

const resolveGeminiLoginResult = (
  result: GeminiAuthResult,
  exitCode: number
): Effect.Effect<void, AuthError | CommandFailedError> =>
  Effect.gen(function*(_) {
    if (result === "success") {
      if (exitCode !== 0) {
        yield* _(
          Effect.logWarning(
            `Gemini CLI returned exit=${exitCode}, but authentication appears successful; continuing.`
          )
        )
      }
      return
    }

    if (result === "failure") {
      yield* _(
        Effect.fail(
          new AuthError({
            message: "Gemini CLI OAuth authentication failed. Please try again."
          })
        )
      )
    }

    if (exitCode !== 0) {
      yield* _(Effect.fail(new CommandFailedError({ command: "gemini", exitCode })))
    }

    // If we get here with pending result and exit code 0, assume success
    // (user may have completed auth flow successfully)
  })

// CHANGE: run Gemini CLI OAuth login with interactive prompt
// WHY: Gemini CLI with NO_BROWSER=true shows auth URL and waits for user to paste authorization code
// QUOTE(ТЗ): "Типо ждал пока мы вставим ссылку"
// REF: issue-146, PR-147 comment
// SOURCE: https://github.com/google-gemini/gemini-cli
// FORMAT THEOREM: forall (cwd, accountPath): runGeminiOauthLogin(cwd, accountPath) -> auth_completed | error
// PURITY: SHELL
// EFFECT: Effect<void, AuthError | CommandFailedError | PlatformError, CommandExecutor>
// INVARIANT: OAuth credentials are stored by Gemini CLI in ~/.gemini within containerPath
// COMPLEXITY: O(user_interaction)
export const runGeminiOauthLoginWithPrompt = (
  cwd: string,
  accountPath: string,
  options: {
    readonly image: string
    readonly containerPath: string
  }
): Effect.Effect<void, AuthError | CommandFailedError | PlatformError, CommandExecutor.CommandExecutor> =>
  Effect.scoped(
    Effect.gen(function*(_) {
      const executor = yield* _(CommandExecutor.CommandExecutor)
      const hostPath = yield* _(resolveDockerVolumeHostPath(cwd, accountPath))
      const spec = buildDockerGeminiAuthSpec(cwd, hostPath, options.image, options.containerPath)
      const proc = yield* _(startDockerProcess(executor, spec))

      const resultBox: { value: GeminiAuthResult } = { value: "pending" }
      const stdoutFiber = yield* _(Effect.forkScoped(pumpDockerOutput(proc.stdout, 1, resultBox)))
      const stderrFiber = yield* _(Effect.forkScoped(pumpDockerOutput(proc.stderr, 2, resultBox)))

      const exitCode = yield* _(proc.exitCode.pipe(Effect.map(Number)))
      yield* _(Fiber.join(stdoutFiber))
      yield* _(Fiber.join(stderrFiber))
      return yield* _(resolveGeminiLoginResult(resultBox.value, exitCode))
    })
  )
