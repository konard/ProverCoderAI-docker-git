# docker-git

`docker-git` поднимает отдельную Docker-среду для каждого репозитория, issue или PR.
Проекты по умолчанию хранятся в `~/.docker-git`.

## Зачем это нужно

- Один репозиторий — один контейнер, без конфликтов между проектами.
- Можно открывать GitHub issue и PR как отдельные рабочие среды.
- Для существующего проекта можно отдельно включить Playwright MCP.

## Что нужно

- Docker Engine или Docker Desktop
- Доступ к Docker без `sudo`
- Node.js и `npm`

## Установка

```bash
npm i -g @prover-coder-ai/docker-git
```

Альтернатива:

```bash
pnpm add -g @prover-coder-ai/docker-git
```

Проверка:

```bash
docker-git --help
```

## Быстрый старт

Авторизация GitHub:

```bash
docker-git auth github login --web
```

Клонировать репозиторий в отдельную среду:

```bash
docker-git clone https://github.com/org/repo
```

Клонировать issue как отдельную среду:

```bash
docker-git clone https://github.com/org/repo/issues/123
```

Открыть уже созданный проект:

```bash
docker-git open https://github.com/org/repo/issues/123
```

Включить Playwright MCP для существующего проекта:

```bash
docker-git mcp-playwright --project-dir .
```

## Где лежат проекты

По умолчанию: `~/.docker-git`

## Подробности

- Все команды и флаги: `docker-git --help`
- API-документация: [packages/api/README.md](packages/api/README.md)
