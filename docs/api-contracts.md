# API Контракты (Control-plane)

## Назначение
Этот API используется Console (frontend SPA) для работы с backend:
- создание и версионирование BotSpec,
- генерация артефактов,
- деплой и откаты ревизий,
- просмотр истории и статусов,
- подписка на события (SSE).

## Общие положения
- **Базовый URL:** `https://api.<domain>`
- **Аутентификация:** cookie-сессии (HttpOnly, Secure, SameSite=Lax)
- **CORS:** разрешён только `Origin: https://console.<domain>` + `credentials: include`
- **CSRF:** все мутирующие запросы требуют `X-CSRF-Token`
- **RBAC:** роли Owner/Editor/Viewer (на проект/бот)
- **Контент-тип:** `application/json; charset=utf-8`
- **ETag/If-None-Match/If-Match:** кэш и optimistic concurrency для чтения/изменения версий
- **Идемпотентность:** `Idempotency-Key` для `/spec`, `/generate`, `/deploy`, `/rollback`
- **Формат ошибки (единый):**
{ "error": { "code": "SPEC_INVALID_SCHEMA", "message": "Поле flows[2].steps[1] некорректно", "path": "flows[2].steps[1]" } }

## Rate-limit заголовки: X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset

## Эндпоинты 

1) Spec
- POST /spec  
  Путь: /spec  
  Назначение: создать новую версию BotSpec  
  Важные заголовки (resp): ETag: "specVersion-N"  
  Коды ответов: 201, 400  

- GET /spec/latest  
  Путь: /spec/latest  
  Назначение: получить последнюю версию BotSpec  
  Важные заголовки (resp): ETag: "specVersion-N"  
  Коды ответов: 200, 304, 404  

- GET /spec/:version  
  Путь: /spec/:version  
  Назначение: получить конкретную версию BotSpec  
  Важные заголовки (resp): ETag: "specVersion-N"  
  Коды ответов: 200, 304, 404  

2) Generate
- POST /generate  
  Путь: /generate  
  Назначение: запустить сборку артефактов  
  Важные заголовки (resp): none  
  Коды ответов: 202, 400, 404, 409, 503  

- GET /tasks/:taskId  
  Путь: /tasks/:taskId  
  Назначение: проверить статус задачи (fallback)  
  Важные заголовки (resp): none  
  Коды ответов: 200, 404  

3) Revisions
- GET /revisions  
  Путь: /revisions  
  Назначение: список ревизий (с пагинацией)  
  Важные заголовки (resp): none  
  Коды ответов: 200  

- GET /revisions/:revHash  
  Путь: /revisions/:revHash  
  Назначение: детали ревизии  
  Важные заголовки (resp): ETag: "rev-<revHash>"  
  Коды ответов: 200, 304, 404  

4) Deploy / Rollback
- POST /deploy  
  Путь: /deploy  
  Назначение: раскатить ревизию  
  Важные заголовки (resp): none  
  Коды ответов: 202, 404, 409, 503  

- POST /rollback  
  Путь: /rollback  
  Назначение: откатиться на ревизию (предыдущую или указанную)  
  Важные заголовки (resp): none  
  Коды ответов: 202, 404, 409  

- GET /deployments/:taskId  
  Путь: /deployments/:taskId  
  Назначение: статус конкретного деплоя  
  Важные заголовки (resp): none  
  Коды ответов: 200, 404  

5) Events (SSE)
- GET /events  
  Путь: /events  
  Назначение: единый поток событий (Server-Sent Events)  
  Важные заголовки (resp): Content-Type: text/event-stream  
  Коды ответов: 200  

## Примеры событий SSE
event: GenerateStarted
data: { "taskId": "gen_123", "specVersion": 42 }

event: GenerateProgress
data: { "taskId": "gen_123", "step": "ast_filter" }

event: GenerateSucceeded
data: { "taskId": "gen_123", "revHash": "abc123" }

event: GenerateFailed
data: { "taskId": "gen_123", "reason": "GENERATOR_UNAVAILABLE" }

event: DeployStarted
data: { "taskId": "dep_789", "revHash": "abc123" }

event: DeployProgress
data: { "taskId": "dep_789", "stage": "prewarm", "ready": 8, "total": 10 }

event: DeployFlipped
data: { "taskId": "dep_789", "revHash": "abc123" }

event: DeployFailed
data: { "taskId": "dep_789", "reason": "RUNTIME_UNAVAILABLE" }

## Диаграммы последовательностей
1) Generate
Console ── POST /generate ──▶ API
API ── enqueue gen:tasks ──▶ Queue
Generator ── build bot.js/spec.json/rev.json ──▶ S3 + PG
API ── SSE events ──▶ Console

2) Deploy
Console ── POST /deploy ──▶ API
API ── enqueue deploy:tasks ──▶ Queue
Deployer ── stage → prewarm → health → flip → invalidate ──▶ Runtime
API ── SSE events ──▶ Console

## Коды ошибок (для UI)
SPEC_INVALID_SCHEMA — неверная структура BotSpec
SPEC_REF_NOT_FOUND — ссылка на несуществующий flow/step/locale
LIMIT_EXCEEDED — превышены лимиты (flows/steps/state/spec size)
SECURITY_VIOLATION — домен вне allow-list / запрещённое поле
REVISION_NOT_FOUND — не существует revHash
DEPLOY_CONFLICT — уже идёт деплой / конфликт задач
GENERATOR_UNAVAILABLE — воркер недоступен
RUNTIME_UNAVAILABLE — рантайм недоступен
BUSY — очередь задач переполнена
NOT_FOUND — бот/проект/задача не найдены
UNAUTHORIZED / FORBIDDEN — нет сессии или прав

## Пагинация и кэширование
Списки (/revisions): pageSize, pageToken; сортировка createdAt desc
Кэш: ETag + If-None-Match для чтения Spec/Revision
Артефакты в S3/CDN: immutable TTL (долгий)
