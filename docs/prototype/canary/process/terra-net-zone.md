
## Твоя зона: net (HTTP, TLS, DNS)

Группы: G02, G40, G41, G42, G43, G44, G46, G48. G46 и G48 — `verify-then-fix`, остальные — `fix`.

Файлы зоны:
- `src/collectors/{http,tls,dns}/**`
- `src/core/headers.ts`
- `src/checks/{http,dns}/**`
- `data/{ruleset/de-2026,texts/de,texts/en,crm}/{http,dns}.yaml`
- тесты в `test/unit/checks/{http,dns}/**`, `test/integration/{http,tls,dns}/**`, `test/fixtures/snapshots/{http,dns}/**`

Особенности:
- **G02.** Параллельно зона privacy создаёт `src/core/redact.ts` с общей функцией маскирования e-mail и `mailto:`. Если файл уже есть, используй его: в коллекторе — прямой импорт, в `src/checks/**` — только через `src/core/api.ts`. Если файла нет, исправь маску в `src/checks/dns/lib/records.ts` и маскирование в `src/collectors/dns/collect.ts` в своей зоне по правилу консенсуса. В `crossZone` попроси интегратора перевести всё на общую функцию.
- **G46.** Поле `environment.trustStore` в `src/core/snapshot.ts` и запись в `scripts/canary-runner.ts` — чужие файлы, их опиши в `crossZone`.
