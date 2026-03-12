# docker-git

`docker-git` создаёт отдельную Docker-среду для каждого репозитория, issue или PR.
По умолчанию проекты лежат в `~/.docker-git`.

## Что нужно

- Docker Engine или Docker Desktop
- Доступ к Docker без `sudo`
- Node.js и `npm`

## Установка

```bash
npm i -g @prover-coder-ai/docker-git
docker-git --help
```

## Авторизация

```bash
docker-git auth github login --web
docker-git auth codex login --web
docker-git auth claude login --web
```

## Пример

```bash
docker-git clone https://github.com/agiens/crm/tree/vova-fork --force --mcp-playwright
```

- `--force` пересоздаёт окружение и удаляет volumes проекта.
- `--mcp-playwright` включает Playwright MCP и Chromium sidecar для браузерной автоматизации.
- `--auto` работает вместе с `--claude` или `--codex`: агент выполняет задачу автономно, а `docker-git` ждёт завершения и очищает контейнер.

## Подробности

`docker-git --help`
