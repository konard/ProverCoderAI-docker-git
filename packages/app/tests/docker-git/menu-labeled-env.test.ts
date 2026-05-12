import { describe, expect, it } from "@effect/vitest"

import { buildLabeledEnvKey, countKeyEntries, normalizeLabel } from "../../src/docker-git/menu-labeled-env.js"
import { normalizeUpperSnakeLabel } from "../../src/shared/label-normalization.js"

describe("labeled environment keys", () => {
  it("normalizes labels through the shared upper-snake invariant", () => {
    expect(normalizeUpperSnakeLabel("  Team A / deploy  ")).toBe("TEAM_A_DEPLOY")
    expect(normalizeLabel("  Team A / deploy  ")).toBe("TEAM_A_DEPLOY")
    expect(buildLabeledEnvKey("GITLAB_TOKEN", "Team A / deploy")).toBe("GITLAB_TOKEN__TEAM_A_DEPLOY")
  })

  it("maps empty and default labels to the base key", () => {
    expect(normalizeUpperSnakeLabel(" -- ")).toBe("")
    expect(normalizeLabel(" -- ")).toBe("")
    expect(buildLabeledEnvKey("GITLAB_TOKEN", "default")).toBe("GITLAB_TOKEN")
  })

  it("counts default and labeled key entries with non-empty values", () => {
    expect(countKeyEntries("GITLAB_TOKEN=one\nGITLAB_TOKEN__WORK=two\nGITLAB_TOKEN__EMPTY=\n", "GITLAB_TOKEN"))
      .toBe(2)
  })
})
