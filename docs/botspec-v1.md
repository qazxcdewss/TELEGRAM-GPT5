# BotSpec v1 — спецификация

## Назначение
**BotSpec** — это декларативное описание логики бота (JSON).  
Он является источником правды для:
- **Console** (редактор),
- **Generator** (создаёт bot.js),
- **Runtime** (исполняет flows),
- **Analytics** (события/метрики).

## Разделы BotSpec

### 1. meta
- `botId`: уникальный идентификатор бота.
- `name`: отображаемое имя.
- `locales`: список поддерживаемых языков (`["ru","en"]`).
- `defaultLocale`: язык по умолчанию.
- `schema_ver`: версия схемы BotSpec (semver).
- Дополнительно: `timezone`, `retention` (TTL для state/events), `pii_policy`.

### 2. commands
- Набор Telegram-команд (`/start`, `/help`, кастомные).
- Каждая команда указывает целевой `flow`.

### 3. intents
- Словари ключевых слов по локалям.
- Поля: `id`, `keywords{locale:[]}`, `priority`, `cooldownSec`, `flow`.
- Инварианты:  
  - Один intent → один flow.  
  - Несколько intents могут вести в один flow.  
  - Циклы запрещены.

### 4. flows
- Набор сценариев (flows), каждый состоит из шагов.
- Шаги (MVP):
  - `reply` (отправить текст/медиа, optional keyboard),
  - `ask` (задать вопрос, ожидать ответ, сохранить в state),
  - `validate` (проверить значение по regex/schema),
  - `save` (сохранить в state),
  - `apiCall` (вызов внешнего API через outbound proxy),
  - `goto` (перейти на шаг/flow).
- Связи: `next`, `onFail`, `targetFlow`, условия `when`.

### 5. state
- Key-value модель per-chat.
- Типы: строки, числа, булевы, неглубокие объекты.
- Лимиты: ≤64 KB на чат, TTL 60 дней.
- Возможны флаги PII (mask в логах).

### 6. localization
- Словарь строк по локалям.
- Подстановки вида `{{state.key}}`, `{{context.chatId}}`.
- Fallback: если ключа нет → используем defaultLocale.

### 7. telemetry
- Встроенные события: `flow_started`, `step_completed`, `validation_failed`, `api_ok`, `api_error`.
- Конфигурируются в Spec (`telemetry.enabled`).
- PII запрещены, только агрегаты.

### 8. security
- Жёсткие ограничения для генерации bot.js:
  - только SDK рантайма,  
  - outbound-домены по allow-list,  
  - apiCall — JSON-only, размер ответа ≤64 KB, timeout ≤5s.
- Запрещённый JS/APIs: `fs`, `net`, `child_process`, глобальные выражения.

---

## Инварианты и лимиты

### Общие
- **Иммутабельность**: сохранённая `specVersion-N` не меняется.
- **Детерминизм**: canonical-форма Spec → стабильный hash.
- **Ссылочная целостность**: все ссылки на flow/step/locale валидны.
- **Fallback**: всегда есть defaultLocale.
- **Запрещённый код**: только декларативные шаги, никаких произвольных выражений.

### Лимиты (v1)
- Размер Spec ≤ 512 KB.
- Flows ≤ 100.
- Steps/flow ≤ 50.
- Переходов за апдейт ≤ 200.
- State/chat ≤ 64 KB.
- apiCall ≤ 2 за апдейт; таймаут ≤ 5s; ответ ≤ 64 KB.
- bot.js ≤ 1–2 MB (gzip).

---

## JSON Schema v1
*(отдельный файл, подключается как `botspec.schema.json`)*  
- Определяет структуру и типы полей (meta, commands, intents, flows, localization, state, telemetry, security).
- Используется в Spec Service (AJV) для валидации.

---

## Фикстуры

### Валидные
1. **hello-world**
- `/start` → reply "Hello!"
- 1 flow, 1 шаг.

2. **анкета**
- `/start` → ask "Ваше имя" → save → reply "Спасибо, {{state.name}}".

3. **заказ пиццы**
- intent `"пицца"` → flow:
  - ask size → validate (enum small/medium/large),
  - ask address → save,
  - apiCall → reply "Заказ принят".

### Невалидные
1. Flow с переходом на несуществующий step (`SPEC_REF_NOT_FOUND`).
2. Intent без целевого flow (`SPEC_REF_NOT_FOUND`).
3. Превышение лимитов (flow со 120 шагами → `LIMIT_EXCEEDED`).
4. apiCall на домен вне allow-list (`SECURITY_VIOLATION`).
5. Локализация без defaultLocale (`LOCALE_MISSING_KEY`).

---

## Коды ошибок валидации
- `SPEC_INVALID_SCHEMA`
- `SPEC_REF_NOT_FOUND`
- `LIMIT_EXCEEDED`
- `SECURITY_VIOLATION`
- `LOCALE_MISSING_KEY`
