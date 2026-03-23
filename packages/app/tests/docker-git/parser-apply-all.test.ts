import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import { parseOrThrow } from "./parser-helpers.js"

describe("parseArgs apply-all --active", () => {
  it.effect("parses apply-all and update-all without --active as activeOnly=false", () =>
    Effect.sync(() => {
      for (const alias of ["apply-all", "update-all"] as const) {
        const command = parseOrThrow([alias])
        expect(command._tag).toBe("ApplyAll")
        if (command._tag === "ApplyAll") {
          expect(command.activeOnly).toBe(false)
        }
      }
    }))

  it.effect("parses apply-all and update-all with --active as activeOnly=true", () =>
    Effect.sync(() => {
      for (const alias of ["apply-all", "update-all"] as const) {
        const command = parseOrThrow([alias, "--active"])
        expect(command._tag).toBe("ApplyAll")
        if (command._tag === "ApplyAll") {
          expect(command.activeOnly).toBe(true)
        }
      }
    }))
})
