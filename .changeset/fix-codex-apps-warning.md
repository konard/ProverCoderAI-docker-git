---
"@prover-coder-ai/docker-git": patch
---

fix(codex): remove apps feature flag to suppress codex_apps MCP startup warning

The `apps = true` setting in `[features]` caused Codex to start a built-in `codex_apps`
MCP client that tried to connect to `https://chatgpt.com/backend-api/wham/apps`.
This connection fails inside Docker containers and produces a noisy startup warning:

```
⚠ MCP client for `codex_apps` failed to start: MCP startup failed: handshaking with MCP server failed
⚠ MCP startup incomplete (failed: codex_apps)
```

Removed `apps = true` from the default Codex config in both `auth-sync.ts` and the
entrypoint template in `codex.ts`. The apps/ChatGPT connectors feature is not needed
for docker-git workflows.
