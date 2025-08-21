# Инварианты и лимиты (invariants-limits.md)

## Назначение
Инварианты и лимиты фиксируют правила, которые обеспечивают целостность системы, предсказуемость поведения и эксплуатационную стабильность.  
Эти правила применяются ко всем уровням: Control-plane, Runtime-plane, артефакты и хранилища.

---

## Control-plane

### Инварианты
- **Иммутабельность Spec:** сохранённая `specVersion-N` никогда не изменяется.  
- **Каноникализация:** Spec всегда хранится в canonical JSON-форме.  
- **Детерминизм генерации:** `(specVersion, model, seed)` → один и тот же `revHash`.  
- **ETag:** чтение возвращает `ETag: "specVersion-N"`.  
- **Optimistic concurrency:** при изменениях используется `If-Match`.  
- **Идемпотентность:** повторный `POST` с тем же `Idempotency-Key` не создаёт дубль.

### Лимиты
- Размер BotSpec ≤ 512 KB.  
- Flows ≤ 100.  
- Steps в одном flow ≤ 50.  
- Количество переходов в одном апдейте ≤ 200.  

---

## Runtime-plane

### Webhook Ingress
- **Секрет:** обязательная проверка секрета/токена.  
- **Идемпотентность:** ключ `idemp:update:<botId>:<update_id>` в Redis (TTL 24h).  
- **Per-chat FIFO:** апдейты одного чата всегда в очереди по порядку.  
- **Rate-limits:** глобальные и per-bot лимиты, анти-спам.  
- **Ответ:** быстрый `200 OK`, чтобы Telegram не ретраил.

### Executor
- **LRU-кэш:** 200–500 песочниц на ноду, TTL 10–20 мин.  
- **Sandbox:** только SDK, запрещены `fs`, `net`, `child_process`.  
- **SLO:** cold start ≤ 400 ms, обработка апдейта ≤ 10 s.  

### Outbound (Telegram API)
- **Token bucket:** per-bot (30/s), per-chat (1/s).  
- **Respect retry_after:** соблюдение backoff при 429.  
- **DLQ:** недоставленные исходящие сообщения уходят в `dlq:out:<botId>`.

### Analytics
- **События:** только агрегаты (`flow_started`, `step_completed`, `api_ok`, `api_error`).  
- **Без PII:** персональные данные маскируются или исключаются.  

---

## DLQ (Dead Letter Queue)

### Входящие
- Сохраняются все «ядовитые» апдейты (битая структура, ошибки в bot.js).  
- Хранятся с причиной (`errorCode`, `trace`).  
- Не блокируют очередь для других апдейтов.

### Исходящие
- Сообщения, которые не удалось отправить после N ретраев.  
- Логируются для анализа и ручного восстановления.

---

## Артефакты

### Инварианты
- `spec.json`: всегда соответствует JSON Schema v1.  
- `bot.js`: детерминирован относительно Spec + buildMeta, безопасный SDK.  
- `rev.json`: содержит все метаданные, хэши файлов и совпадает с фактическим содержимым.  
- **Иммутабельность:** артефакты в S3 не перезаписываются.  

### Лимиты
- `bot.js` ≤ 1–2 MB (gzip).  
- `spec.json` ≤ 512 KB.  
- Ответ `apiCall` ≤ 64 KB.  
- Время выполнения `apiCall` ≤ 5 s.  
- Кол-во `apiCall` ≤ 2 на один апдейт.  

---

## Storage & Observability

### Postgres
- RLS по `tenant_id`.  
- Иммутабельные записи Spec и Revision.  

### Redis
- Namespaces по botId.  
- TTL на idempotency-ключи и state.  
- Очереди per-chat FIFO.  

### S3
- Версионирование включено.  
- Immutable артефакты ревизий.  

### ClickHouse
- Таблица `bot_events_raw` с TTL 180 дней.  
- Materialized Views для воронок и KPI.  

### Monitoring
- Метрики: `webhook_latency_ms`, `tg_429_rate`, `queue_wait_ms`, `lru_hit_rate`, `ingest_lag_ms`, размеры DLQ.  
- Алерты: p95 webhook < 800 ms, 429-rate < 2%, DLQ не растёт.  

---

## Коды ошибок (основные)
- `SPEC_INVALID_SCHEMA`  
- `SPEC_REF_NOT_FOUND`  
- `LIMIT_EXCEEDED`  
- `SECURITY_VIOLATION`  
- `REVISION_NOT_FOUND`  
- `DEPLOY_CONFLICT`  
- `GENERATOR_UNAVAILABLE`  
- `RUNTIME_UNAVAILABLE`  
- `BUSY`  
- `NOT_FOUND`  
- `UNAUTHORIZED` / `FORBIDDEN`

---
