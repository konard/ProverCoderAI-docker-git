import type { PlatformError } from "@effect/platform/Error"
import * as FileSystem from "@effect/platform/FileSystem"
import * as Path from "@effect/platform/Path"
import { Effect } from "effect"

import type { AgentMode, ParseError, TemplateConfig } from "../core/domain.js"
import { normalizeAccountLabel } from "./auth-helpers.js"

const autoOptionError = (reason: string): ParseError => ({
  _tag: "InvalidOption",
  option: "--auto",
  reason
})

const isNonEmptyFile = (
  fs: FileSystem.FileSystem,
  filePath: string
): Effect.Effect<boolean, PlatformError> =>
  Effect.gen(function*(_) {
    const exists = yield* _(fs.exists(filePath))
    if (!exists) {
      return false
    }
    const info = yield* _(fs.stat(filePath))
    if (info.type !== "File") {
      return false
    }
    const text = yield* _(fs.readFileString(filePath), Effect.orElseSucceed(() => ""))
    return text.trim().length > 0
  })

const isRegularFile = (
  fs: FileSystem.FileSystem,
  filePath: string
): Effect.Effect<boolean, PlatformError> =>
  Effect.gen(function*(_) {
    const exists = yield* _(fs.exists(filePath))
    if (!exists) {
      return false
    }
    const info = yield* _(fs.stat(filePath))
    return info.type === "File"
  })

const hasCodexAuth = (
  fs: FileSystem.FileSystem,
  rootPath: string,
  label: string | undefined
): Effect.Effect<boolean, PlatformError> => {
  const normalized = normalizeAccountLabel(label ?? null, "default")
  const authPath = normalized === "default"
    ? `${rootPath}/auth.json`
    : `${rootPath}/${normalized}/auth.json`
  return isNonEmptyFile(fs, authPath)
}

const resolveClaudeAccountPath = (rootPath: string, label: string | undefined): ReadonlyArray<string> => {
  const normalized = normalizeAccountLabel(label ?? null, "default")
  if (normalized !== "default") {
    return [`${rootPath}/${normalized}`]
  }
  return [`${rootPath}`, `${rootPath}/default`]
}

const hasClaudeAuth = (
  fs: FileSystem.FileSystem,
  rootPath: string,
  label: string | undefined
): Effect.Effect<boolean, PlatformError> =>
  Effect.gen(function*(_) {
    for (const accountPath of resolveClaudeAccountPath(rootPath, label)) {
      const oauthToken = yield* _(isNonEmptyFile(fs, `${accountPath}/.oauth-token`))
      if (oauthToken) {
        return true
      }

      const credentials = yield* _(isRegularFile(fs, `${accountPath}/.credentials.json`))
      if (credentials) {
        return true
      }

      const nestedCredentials = yield* _(isRegularFile(fs, `${accountPath}/.claude/.credentials.json`))
      if (nestedCredentials) {
        return true
      }
    }

    return false
  })

export const resolveAutoAgentMode = (
  config: Pick<TemplateConfig, "agentAuto" | "agentMode" | "claudeAuthLabel" | "codexAuthLabel" | "codexSharedAuthPath">
): Effect.Effect<AgentMode | undefined, ParseError | PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*(_) {
    const fs = yield* _(FileSystem.FileSystem)

    if (config.agentAuto !== true) {
      return config.agentMode
    }

    if (config.agentMode === "claude") {
      const claudeRoot = `${config.codexSharedAuthPath.slice(0, config.codexSharedAuthPath.lastIndexOf("/"))}/claude`
      const available = yield* _(hasClaudeAuth(fs, claudeRoot, config.claudeAuthLabel))
      if (!available) {
        return yield* _(Effect.fail(autoOptionError("Claude auth not found")))
      }
      return "claude"
    }

    if (config.agentMode === "codex") {
      const available = yield* _(hasCodexAuth(fs, config.codexSharedAuthPath, config.codexAuthLabel))
      if (!available) {
        return yield* _(Effect.fail(autoOptionError("Codex auth not found")))
      }
      return "codex"
    }

    const claudeRoot = `${config.codexSharedAuthPath.slice(0, config.codexSharedAuthPath.lastIndexOf("/"))}/claude`
    const claudeAvailable = yield* _(hasClaudeAuth(fs, claudeRoot, config.claudeAuthLabel))
    const codexAvailable = yield* _(hasCodexAuth(fs, config.codexSharedAuthPath, config.codexAuthLabel))

    if (!claudeAvailable && !codexAvailable) {
      return yield* _(Effect.fail(autoOptionError("no Claude or Codex auth found")))
    }
    if (claudeAvailable && !codexAvailable) {
      return "claude"
    }
    if (!claudeAvailable && codexAvailable) {
      return "codex"
    }

    return Math.random() < 0.5 ? "claude" : "codex"
  })
