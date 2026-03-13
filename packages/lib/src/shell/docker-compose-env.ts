import type * as CommandExecutor from "@effect/platform/CommandExecutor"
import { Effect } from "effect"

import { resolveDockerEnvValue, resolveDockerVolumeHostPath, trimDockerPathTrailingSlash } from "./docker-auth.js"

export const composeSpec = (cwd: string, args: ReadonlyArray<string>) => ({
  cwd,
  command: "docker",
  args: ["compose", "--ansi", "never", "--progress", "plain", ...args]
})

const resolveProjectsRootCandidate = (): string | null => {
  const explicit = resolveDockerEnvValue("DOCKER_GIT_PROJECTS_ROOT")
  if (explicit !== null) {
    return explicit
  }

  const home = resolveDockerEnvValue("HOME") ?? resolveDockerEnvValue("USERPROFILE")
  return home === null ? null : `${trimDockerPathTrailingSlash(home)}/.docker-git`
}

export const resolveDockerComposeEnv = (
  cwd: string
): Effect.Effect<Readonly<Record<string, string>>, never, CommandExecutor.CommandExecutor> =>
  Effect.gen(function*(_) {
    const projectsRoot = resolveProjectsRootCandidate()
    if (projectsRoot === null) {
      return {}
    }

    const remappedProjectsRoot = yield* _(resolveDockerVolumeHostPath(cwd, projectsRoot))
    return remappedProjectsRoot === projectsRoot ? {} : { DOCKER_GIT_PROJECTS_ROOT_HOST: remappedProjectsRoot }
  })
