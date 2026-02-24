# @effect-template/api

Clean-slate v1 HTTP API for docker-git orchestration.

## UI wrapper

После запуска API открой:

- `http://localhost:3334/`

Это встроенная фронт-обвязка для ручного тестирования endpoint-ов (проекты, агенты, логи, SSE).

## Run

```bash
pnpm --filter ./packages/api build
pnpm --filter ./packages/api start
```

Env:

- `DOCKER_GIT_API_PORT` (default: `3334`)
- `DOCKER_GIT_PROJECTS_ROOT` (default: `~/.docker-git`)
- `DOCKER_GIT_API_LOG_LEVEL` (default: `info`)
- `DOCKER_GIT_FEDERATION_PUBLIC_ORIGIN` (optional public ActivityPub domain, e.g. `https://social.my-domain.tld`)
- `DOCKER_GIT_FEDERATION_ACTOR` (default: `docker-git`)

## Endpoints (v1)

- `GET /v1/health`
- `POST /v1/federation/inbox` (ForgeFed `Ticket` / `Offer(Ticket)`, ActivityPub `Accept` / `Reject`)
- `GET /v1/federation/issues`
- `GET /v1/federation/actor` (ActivityPub `Person`)
- `GET /v1/federation/outbox`
- `GET /v1/federation/followers`
- `GET /v1/federation/following`
- `GET /v1/federation/liked`
- `POST /v1/federation/follows` (create ActivityPub `Follow` activity for task-feed subscription)
- `GET /v1/federation/follows`
- `GET /v1/projects`
- `GET /v1/projects/:projectId`
- `POST /v1/projects`
- `DELETE /v1/projects/:projectId`
- `POST /v1/projects/:projectId/up`
- `POST /v1/projects/:projectId/down`
- `POST /v1/projects/:projectId/recreate`
- `GET /v1/projects/:projectId/ps`
- `GET /v1/projects/:projectId/logs`
- `GET /v1/projects/:projectId/events` (SSE)
- `POST /v1/projects/:projectId/agents`
- `GET /v1/projects/:projectId/agents`
- `GET /v1/projects/:projectId/agents/:agentId`
- `GET /v1/projects/:projectId/agents/:agentId/attach`
- `POST /v1/projects/:projectId/agents/:agentId/stop`
- `GET /v1/projects/:projectId/agents/:agentId/logs`

## Example

```bash
curl -s http://localhost:3334/v1/projects
curl -s -X POST http://localhost:3334/v1/projects/<projectId>/up
curl -s -N http://localhost:3334/v1/projects/<projectId>/events

curl -s http://localhost:3334/v1/federation/actor

curl -s -X POST http://localhost:3334/v1/federation/follows \
  -H 'content-type: application/json' \
  -d '{"domain":"social.my-domain.tld","object":"https://social.my-domain.tld/issues/followers"}'

curl -s -X POST http://localhost:3334/v1/federation/inbox \
  -H 'content-type: application/json' \
  -d '{"@context":["https://www.w3.org/ns/activitystreams","https://forgefed.org/ns"],"id":"https://social.my-domain.tld/offers/42","type":"Offer","target":"https://social.my-domain.tld/issues","object":{"type":"Ticket","id":"https://social.my-domain.tld/issues/42","attributedTo":"https://origin.my-domain.tld/users/alice","summary":"Title","content":"Body"}}'
```
