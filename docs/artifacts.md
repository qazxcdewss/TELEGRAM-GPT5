# Артефакты ревизии (artifacts.md)

## Назначение
Каждая ревизия бота собирается в виде набора артефактов.  
Они являются immutable и хранятся в S3/объектном хранилище.  
Набор файлов одинаков для всех ревизий и используется Generator, Deployer и Runtime.

---

## Общая структура в S3
s3://bots/<botId>/<revHash>/
├─ bot.js
├─ spec.json
└─ rev.json

---

## Артефакты

1) **spec.json**  
- Путь: `<revHash>/spec.json`  
- Назначение: канонизированный снапшот BotSpec  
- Важные заголовки (resp): `ETag: "spec-<specVersion>"`  
- Коды ответов: 200, 304, 404  

**Инварианты:**  
- Точная canonical-форма Spec (детерминированный JSON).  
- Ссылочная целостность (flows, steps, intents, локализация).  
- Соответствует BotSpec v1 Schema.  
- Размер ≤ 512 KB.  

---

2) **bot.js**  
- Путь: `<revHash>/bot.js`  
- Назначение: исполняемый код для Runtime (isolated-vm sandbox).  
- Важные заголовки (resp): `ETag: "bot-<revHash>"`  
- Коды ответов: 200, 404  

**Инварианты:**  
- Содержит только SDK-вызовы (нет `fs`, `net`, `child_process`).  
- Детерминирован относительно `spec.json` + buildMeta.  
- Размер ≤ 1–2 MB (gzip).  
- Cold start ≤ 400ms, исполнение апдейта ≤ 10s.  

---

3) **rev.json**  
- Путь: `<revHash>/rev.json`  
- Назначение: паспорт ревизии (манифест сборки).  
- Важные заголовки (resp): `ETag: "rev-<revHash>"`  
- Коды ответов: 200, 304, 404  

**Обязательные поля:**  
- `revHash`: строка, главный идентификатор ревизии.  
- `specVersion`: номер версии BotSpec.  
- `artifacts`: ссылки на `bot.js`, `spec.json`, `rev.json`.  
- `build`: модель (gpt-5), seed, sdkVersion, astRulesVersion, generatorGitSha, builtAt.  
- `hashes`: sha256 хэши файлов (`spec.json`, `bot.js`).  
- `sizes`: размеры артефактов в байтах.  
- `security`: outboundAllowList, лимиты apiCall.  
- `author`: инициатор генерации (userId/system).  
- `notes`: комментарий (опционально).  

**Инварианты:**  
- `revHash` детерминирован от spec.json + buildMeta.  
- Все `hashes.*` совпадают с реальным содержимым файлов.  
- Соответствие между `security` и `spec.json.security`.  

---

## Preflight-проверки при деплое
- Валидность `spec.json` по JSON Schema v1.  
- Хэши и размеры из `rev.json` совпадают с артефактами.  
- `bot.js` прошёл AST-фильтрацию (нет запрещённых вызовов).  
- Лимиты не превышены (размеры, apiCall).  
- `revHash` корректно пересчитывается и совпадает.  

---

## Пагинация и кэширование
- Чтение артефактов через CDN/S3 с immutable TTL (1 год).  
- `ETag` + `If-None-Match` для кэширования в Console.  
- rev.json используется как основной дескриптор ревизии.

