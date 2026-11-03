# AGENTS.md — правила для агентов, которые работают с кодом dsgvo-check

dsgvo-check — пассивный CLI-сканер на TypeScript и Playwright: ищет на сайтах признаки нарушений DSGVO/TDDDG/DDG и базовые проблемы безопасности, по найденному роняет CI. В репозитории прототип и утверждённые документы релиза 1.0.

## Где правда

Приоритет: решение заказчика → [ТЗ](specs/dsgvo-check_TZ.md) → [каталог проверок](specs/dsgvo-check_katalog-proverok.md) → [архитектура](docs/02-architecture.md) и [спецификация проверок](docs/03-checks.md) → остальные документы.

Исключение — варианты реализованных проверок: имена, уровни по умолчанию, `locked` и `crm` задаёт `test/data/ruleset/de-2026/*.yaml`. Таблица в `docs/03-checks.md` §2.1 генерируется из него.

| Нужно                           | Документ                                                               |
| ------------------------------- | ---------------------------------------------------------------------- |
| Что строим и почему             | [docs/00-brief.md](docs/00-brief.md)                                   |
| Архитектура одним взглядом      | [docs/architecture.md](docs/architecture.md)                           |
| Контракты, модули, поля         | [docs/02-architecture.md](docs/02-architecture.md)                     |
| Поведение проверок, `messageId` | [docs/03-checks.md](docs/03-checks.md); варианты — `test/data/ruleset` |
| Тексты находок и стоп-слова     | [docs/legal/wording-guide.md](docs/legal/wording-guide.md)             |
| Тесты, CI, Docker, Action       | [docs/04-quality-and-delivery.md](docs/04-quality-and-delivery.md)     |
| Устройство прототипа            | [docs/prototype/BRIEF.md](docs/prototype/BRIEF.md)                     |

Решение противоречит этим документам — остановись и спроси. Документ «под код» молча не переписывай.

## Команды

```bash
corepack pnpm install
node node_modules/playwright-core/cli.js install --no-shell chromium
corepack pnpm typecheck && corepack pnpm lint
corepack pnpm test:unit          # L0–L1, без браузера и сети
corepack pnpm test:integration   # L2: настоящий Chromium, локальные серверы, без интернета
corepack pnpm build && corepack pnpm test:e2e   # build пишет и schema/report.schema.json из zod
corepack pnpm registry           # перегенерировать таблицу §2.1 в docs/03-checks.md
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

## Как добавить проверку

Образец чистой проверки — [contract-example.test.ts](test/unit/core/contract-example.test.ts).

1. Создай `src/checks/<module>/<id>.ts` и добавь строку в `src/checks/<module>/index.ts`.
2. Добавь варианты с уровнем и `crm` (код каталога или `null`) в `test/data/ruleset/de-2026/<module>.yaml` и тексты в `test/data/texts/{de,en}/<module>.yaml`. Затем выполни `corepack pnpm registry`.
3. Добавь фикстуры:
   - browser: сценарий `test/unit/checks/browser/scenarios/<id>.ts` и строка в `scenarios/index.ts`;
   - dns: строки в `test/unit/checks/dns/fixtures.ts`;
   - http: JSON в `test/fixtures/snapshots/http/<ID>/`.

Имена вариантов запланированной проверки бери из второй таблицы `docs/03-checks.md` §2.1. После `corepack pnpm registry` проверка переходит в первую.
