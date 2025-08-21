# telegram-gpt5-mvp — сводка для handoff (контекст + прогресс)

Этот документ нужен, чтобы любой новый чат/исполнитель мгновенно вошёл в контекст проекта. В нём: цели, архитектура, ключевые решения (BotSpec, API, артефакты, инварианты), текущее состояние, roadmap и рабочие артефакты.

---

## 1) Миссия и границы MVP

* Платформа «без кода» для запуска **Telegram-ботов** и Mini App.
* **Time‑to‑market:** от идеи до прода за часы.
* **Обновления без простоя** (flip/rollback), прозрачная аналитика.
* MVP фокус: боты (Mini App можно вынести в v1.1+).

---

## 2) Высокоуровневая архитектура

### Доменные зоны

* `console.<domain>` — фронт (React SPA, конструктор/админка).
* `api.<domain>` — backend API (Control-plane + ingress + SSE).
* `app.<domain>` — Mini App (CDN/S3), **не критично для MVP**.

### Основные плоскости

* **Control‑plane** (управление): аутентификация, BotSpec, генерация артефактов, деплой/rollback, события прогресса.
* **Runtime‑plane** (исполнение): webhook ingress, очереди per‑chat FIFO, песочницы `isolated-vm`, outbound Telegram API, rate‑limits, DLQ, аналитика.
* **Storage & Observability**: Postgres, Redis, S3, ClickHouse, Prometheus/Grafana, OpenTelemetry, pino‑логи.

---

## 3) Потоки данных (dataflow) — кратко

* **Создание/изменение бота:** Console → API Gateway → Spec Service (AJV валидация, нормализация) → Postgres (версия Spec immutable).
* **Генерация:** API → Redis Streams `gen:tasks` → Generator (GPT‑5 + AST‑фильтры; в MVP можно заглушку) → артефакты в S3 (`bot.js`, `spec.json`, `rev.json`) → запись в PG `revisions` → SSE статусы.
* **Деплой:** API → `deploy:tasks` → Deployer: stage → pre‑warm → health → flip (атомарно) → invalidate (pub/sub) → SSE статусы → активная ревизия на нодах.
* **Работа бота:** Telegram → **POST /wh/\:botId** (secret, rate‑limit, idempotency) → Redis (per‑chat FIFO) → Executor (sandbox `isolated‑vm` с LRU) → Outbound (token‑bucket per‑bot/per‑chat, уважает `retry_after`) → Telegram API → Analytics Collector → ClickHouse.

---

## 4) BotSpec v1 — источник правды (принято)

**Задача:** декларативно описать поведение бота; из BotSpec генератор создаёт `bot.js`.

### Состав разделов

* `meta` — `botId`, `name`, `locales`, `defaultLocale`, `schema_ver` (+ `timezone`, `retention`, `pii_policy`).
* `commands` — `/start`, `/help`, кастомные; каждая указывает целевой `flow`.
* `intents` (упрощённо): словари ключевых слов по локалям; поля `id`, `keywords{locale}`, `priority`, `cooldownSec`, `flow`.
* `flows` — последовательность шагов (MVP типы):

  * `reply` (text/media, optional quick replies),
  * `ask`, `validate` (`regex`/`schema`), `save`,
  * `apiCall` (через outbound‑proxy; JSON only; allow‑list доменов; `timeoutMs`/`retries`/`backoff`/`map` → state),
  * `goto` (переход, `when`/`elseNext`).
* `state` — key‑value **per‑chat** (+ TTL/PII флаги, лимиты).
* `localization` — строки по локалям с fallback на `defaultLocale`; подстановки `{{state.*}}`, `{{context.*}}` (без вычислений).
* `telemetry` — события (`flow_started`, `step_completed`, `validation_failed`, `api_ok/api_error`).
* `security` — allow‑list доменов, `maxApiResponseKB`, запрет произвольного JS/APIs.

### Инварианты и лимиты (v1)

* Версии Spec **immutable**; canonical JSON; стабильный `hash`.
* flows ≤ 100; steps/flow ≤ 50; переходов/апдейт ≤ 200.
* Spec ≤ 512 KB; state/chat ≤ 64 KB; `apiCall` ≤ 2/апдейт; timeout ≤ 5 s; ответ ≤ 64 KB.
* Любые ссылки валидны (`flow.id`, `step.id`, локализация); fallback по локали обязателен.

---

## 5) API (Control‑plane) — контракты (принято)

### Общие правила

Cookie‑сессии (Auth), CORS (Origin = console.<domain>), CSRF (`X‑CSRF‑Token`), RBAC (Owner/Editor/Viewer), `ETag`/`If‑None‑Match`/`If‑Match`, идемпотентность (`Idempotency‑Key`), SSE `/events`.

### Эндпоинты (txt‑сводка)

**Spec**

* `POST /spec` — создать новую версию (resp: `ETag: "specVersion-N"`; 201/400)
* `GET /spec/latest` — последняя версия (resp: `ETag`; 200/304/404)
* `GET /spec/:version` — конкретная версия (resp: `ETag`; 200/304/404)

**Generate**

* `POST /generate` — запустить сборку (202/400/404/409/503)
* `GET /tasks/:taskId` — статус задачи (200/404)

**Revisions**

* `GET /revisions` — список (200)
* `GET /revisions/:revHash` — детали (resp: `ETag: "rev-<revHash>"`; 200/304/404)

**Deploy / Rollback**

* `POST /deploy` — раскатить ревизию (202/404/409/503)
* `POST /rollback` — откат (202/404/409)
* `GET /deployments/:taskId` — статус деплоя (200/404)

**Events (SSE)**

* `GET /events` — единый поток событий (200; `Content‑Type: text/event-stream`)

### События SSE

`GenerateStarted/Progress/Succeeded{revHash}/Failed{reason}`; `DeployStarted/Progress{stage}/Flipped/Failed`.

---

## 6) Артефакты ревизии (принято)

S3 структура (immutable):

```
s3://bots/<botId>/<revHash>/
  ├─ bot.js      # исполняемый код (sandbox SDK surface)
  ├─ spec.json   # canonical BotSpec (снапшот версии)
  └─ rev.json    # паспорт ревизии (метаданные/хэши/лимиты)
```

* **revHash** детерминирован от `spec.json + buildMetaDeterministic` (модель, seed, версии SDK/AST‑правил и т.п.).
* `rev.json` минимально содержит: `revHash`, `specVersion`, `artifacts{...}`, `build{model,seed,sdkVersion,astRulesVersion,generatorGitSha,builtAt}`, `hashes{specSha256,botJsSha256}`, `sizes{...}`, `security{...}`, `author`, `notes?`.
* Preflight деплоя: валидность Spec, совпадение хэшей/размеров, запретные импорты/URL, лимиты.

---

## 7) Инварианты/ключи/лимиты (принято)

* **Иммутабельность**: Spec/ревизии не переписываются.
* **Идемпотентность**: `Idempotency‑Key` для `/spec|/generate|/deploy|/rollback`; входящие — Redis ключ `idemp:update:<botId>:<update_id>`.
* **Атомарность flip**: только старая или новая ревизия активна.
* **Per‑chat FIFO**: строгий порядок обработки событий чата.
* **Rate‑limits**: token‑bucket per‑bot (≈30/s) и per‑chat (≈1/s), уважение `retry_after`.
* **DLQ**: входящие `dlq:in:<botId>`, исходящие `dlq:out:<botId>`.
* **LRU песочниц**: 200–500/ноду, TTL 10–20 мин, hit‑rate > 75%.

---

## 8) Инфра и готовые артефакты для запуска локалки

* **docker‑compose**: Postgres 16, Redis 7, MinIO (S3), job «create‑bucket».
* **PG схемы (минимум):** `users`, `projects`, `bots(active_rev_hash)`, `spec_versions(id, bot_id, schema_ver, canonical_spec, spec_hash, author_id, created_at)`, `revisions(rev_hash, bot_id, spec_version_id, artifacts_uri, spec_sha256, botjs_sha256, build_meta, created_at)`, `deployments` (статусы, таймстемпы).
* **Redis Streams/keys:**

  * Streams: `gen:tasks`, `deploy:tasks`; Pub/Sub: `rev:set`.
  * Keys: `idemp:update:<botId>:<update_id>`, `state:bot:<id>:chat:<chatId>`, `q:in/out:<botId>:<chatId>`, `dlq:in/out:<botId>`, `ratelimit:bot:<id>`, `ratelimit:chat:<id>`.
* **Форматы задач:**

  * gen: `{taskId, botId, specVersion, model, seed, params}`
  * deploy: `{taskId, botId, revHash, strategy:"flip", prewarm:{minSandboxes}}`
* **OpenAPI черновик** для `/spec`, `/generate`, `/deploy` (см. `docs/api-contracts.md`).

---