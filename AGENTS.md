# AGENTS.md — правила для агентов, которые работают с кодом dsgvo-check

dsgvo-check — пассивный CLI-сканер на TypeScript и Playwright: ищет на сайтах признаки нарушений DSGVO/TDDDG/DDG и базовые проблемы безопасности, по найденному роняет CI. В репозитории прототип и утверждённые документы релиза 1.0.

## Где правда

Приоритет: решение заказчика → [ТЗ](specs/dsgvo-check_TZ.md) → [каталог проверок](specs/dsgvo-check_katalog-proverok.md) → `test/data/ruleset` и код с его тестами → [README.md](README.md) и [docs/architecture.md](docs/architecture.md).

Исключение — варианты реализованных проверок: имена, уровни по умолчанию, `locked` и `crm` задаёт `test/data/ruleset/de-2026/*.yaml`. Таблица в [README.md](README.md) (раздел «Was geprüft wird») генерируется из него.

| Нужно                           | Где смотреть                                                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Что строим и почему             | [specs/dsgvo-check_TZ.md](specs/dsgvo-check_TZ.md), [README.md](README.md)                                                                 |
| Архитектура одним взглядом      | [docs/architecture.md](docs/architecture.md)                                                                                               |
| Контракты, модули, поля         | [docs/architecture.md](docs/architecture.md); схемы в `src/core/snapshot` и `src/core/report`                                              |
| Поведение проверок, `messageId` | `src/checks/**` и их тесты; варианты — `test/data/ruleset`                                                                                 |
| Тексты находок и стоп-слова     | `test/data/texts/**`; правило 3 ниже и `test/unit/core/data/stopwords.test.ts`                                                             |
| Тесты, CI, Docker, Action       | [README.md](README.md), разделы «Entwicklung», «Docker», «CI-Integration»                                                                  |
| Словари, сигнатуры, селекторы   | `test/data/{cmp,legal,browser,http,services}`; перечень — в [docs/architecture.md](docs/architecture.md), раздел «Словари и сопоставления» |
| Устройство прототипа            | [README.md](README.md): примечание о статусе и раздел «Grenzen»                                                                            |

Решение противоречит этим документам — остановись и спроси. Документ «под код» молча не переписывай.

## Команды

```bash
corepack pnpm install
node node_modules/playwright-core/cli.js install --no-shell chromium
corepack pnpm typecheck && corepack pnpm lint
corepack pnpm test:unit          # L0–L1, без браузера и сети; `corepack pnpm test` запускает только их
corepack pnpm test:integration   # L2: настоящий Chromium, локальные серверы, без интернета
corepack pnpm test:changed       # только затронутые тесты: merge-base с main + незакоммиченное
corepack pnpm build && corepack pnpm test:e2e   # build пишет и schema/report.schema.json из zod
corepack pnpm registry           # перегенерировать таблицу вариантов в README.md
corepack pnpm env:example        # перегенерировать .env.example из схемы настроек (env:example:check — проверка)
node dist/cli.js https://example.test --format console,json,html
node dist/cli.js report <report.json> --format html,pdf
```

Версии зависимостей запинены точно (`.npmrc`: `save-exact=true`). Новая зависимость — только с пермиссивной лицензией (MIT, Apache-2.0, BSD, ISC, MPL-2.0). NC-, SA- и GPL-данные в поставку не попадают.

## Жёсткие правила

1. **Только пассивно.** Без логинов, отправки форм, перебора, обхода CAPTCHA и бот-защиты. FILE-01 и ADMIN-01 — только opt-in класс E. Навигации — по одной, пауза ≥ 1,5 с; HTTP-пробы — ≤ 2 запросов/с на хост. User-Agent честный, со ссылкой на репозиторий.
2. **Никаких значений.** Значения cookies, Web Storage и TC-String не попадают в снимок, отчёт, логи и исключения — ни открыто, ни хешем. Query редактируется до `[redacted]` (кроме allowlist), `mailto:` — до домена. Редактирует коллектор до записи.
3. **Факт, а не правовая оценка.** Пользовательские строки лежат только в `test/data/texts/**`. Формулировки: «beobachtet», «nicht gefunden in …». Стоп-слова (verstößt, rechtswidrig, unzulässig, DSGVO-konform, illegal, violates…) проверяет тест. `crmCode` (`T1_…`) выводится только в JSON.
4. **Проверки — чистые функции.** `src/checks/**` импортирует только `src/core/api.ts` и типы: без Playwright, undici и `node:*` I/O (проверяет тест графа импортов). Уровни, gating и `crmCode` — данные в `test/data/ruleset`, а не код.
5. **Нераспознанный баннер → `info` «Banner nicht erkannt».** CONSENT-04 выше `info` выдают только собственные адаптеры CMP при распознавании `high`. Бот- и гео-сигналы переводят проверки в `inconclusive`, а не в находку.
6. **Тесты обязательны.** Каждый вариант проверки покрыт фикстурами `violation`, `clean`, `inconclusive` и контрпримером (тест полноты реестра). Unit- и интеграционные тесты не ходят в интернет. Живые сайты — только в `test/live/**` (по умолчанию не запускается) и в канарейке.
7. **Результаты сканов чужих сайтов не коммитятся и не публикуются.** `canary/results/` и `dsgvo-check-report*` лежат в `.gitignore`.
8. **Git.** Не коммить и не пушь без явной просьбы.
9. **Комментарии объясняют причину.** Без номеров ревью, раундов и канареек, имён моделей, тегов владельцев, декоративных разделителей и меток удалённых решений.
10. **Доставка короткая.** Разбор и проверка входов — в TypeScript. YAML и shell только запускают контейнер, изолируют его и передают отчёты в CI. В `uses:` — теги версий; образ — `ghcr.io/seed-factory/dsgvo-check:<версия из package.json>`.
11. **Тесты описывают поведение.** В именах файлов и сценариев нет истории ревью. Однотипные случаи объединяются в таблицы без потери уникальных входов и требований правила 6.
12. **Новые пороги, таймауты и лимиты — в схему настроек.** Поле в `src/core/config/schema.ts` с умолчанием, границами и описанием (имя переменной `DSGVO_CHECK_<РАЗДЕЛ>_<ИМЯ>`, единица в имени: `_MS`, `_BYTES`, `_DAYS`), затем `corepack pnpm env:example`. Умолчание равно прежнему значению, `.env` остаётся необязательным. Коллектор берёт значение из `ctx.config`, проверка — из `ctx.thresholds` и не импортирует конфиг. Паузы правила 1 в схеме можно только ужесточать. Константы протоколов (SPF, DMARC) и защитные пределы (редактирование, размеры разбора чужого содержимого) остаются в коде.
13. **Словари — в `test/data/`, логика — в коде.** Всё, что меняется вместе с внешним миром (слова и фразы, имена параметров и cookies, сигнатуры бот-защиты и WAF, селекторы и признаки CMP, пути и расширения страниц), лежит в YAML рядом с `cmp/lexicon.yaml` и `legal/links.yaml`, а не в константах. У каждого ключа верхнего уровня есть zod-схема (`dataSection` из `src/core/data/parse.ts`), а файл попадает в `test/unit/core/data/sections.test.ts`. Коллектор берёт значения через `loadSection`, проверка — из `ctx.data` (`data: ['<каталог>']`) и той же чистой схемы, код страницы (`in-page/`, `cmp/page/`) получает их аргументом `evaluate`. В коде остаются таблицы логики (сопоставления внутренних типов, коды ошибок Node и Chromium, словарь протоколов HTTP/TLS/DNS, стандартная разметка) и всё, что защищает приватность: allowlist query и заголовков в `src/core/url` и `src/core/redaction`, скрытые поля в `report-view.ts`.

## Как добавить проверку

Образец чистой проверки — [contract-example.test.ts](test/unit/core/evaluation/contract-example.test.ts).

1. Создай `src/checks/<module>/<id>.ts` и добавь строку в `src/checks/<module>/index.ts`.
2. Добавь варианты с уровнем и `crm` (код каталога или `null`) в `test/data/ruleset/de-2026/<module>.yaml` и тексты в `test/data/texts/{de,en}/<module>.yaml`. Затем выполни `corepack pnpm registry`.
3. Добавь фикстуры:
   - browser: сценарий `test/unit/checks/browser/scenarios/<id>.ts` и строка в `scenarios/index.ts`;
   - dns: строки в `test/unit/checks/dns/fixtures.ts`;
   - http: JSON в `test/fixtures/snapshots/http/<ID>/`.

Имена вариантов запланированной проверки бери из таблицы «Geplante Prüfungen» в [README.md](README.md). После `corepack pnpm registry` проверка переходит в таблицу реализованных.
