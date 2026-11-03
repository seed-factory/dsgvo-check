# AGENTS.md — правила для агентов, которые работают с кодом dsgvo-check

dsgvo-check — пассивный CLI-сканер на TypeScript + Playwright. Он ищет признаки нарушений DSGVO/TDDDG/DDG и базовые проблемы безопасности на сайтах, а по найденному роняет CI. Сейчас в репозитории прототип (`docs/prototype/`) и утверждённые документы релиза 1.0.

## Где правда

Порядок важности: явное решение заказчика → [ТЗ](specs/dsgvo-check_TZ.md) → [каталог проверок](specs/dsgvo-check_katalog-proverok.md) → [архитектура](docs/02-architecture.md) и [спецификация проверок](docs/03-checks.md) → остальные документы. Исключение — варианты реализованных проверок: их имена, уровни по умолчанию, `locked` и `crm` задаёт `data/ruleset/de-2026/*.yaml`, а таблица в `docs/03-checks.md` §2.1 генерируется из него (`corepack pnpm registry`).


| Нужно                                            | Документ                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| Что строим и почему                              | [docs/00-brief.md](docs/00-brief.md)                               |
| Контракты, модули, поля                          | [docs/02-architecture.md](docs/02-architecture.md)                 |
| Поведение каждой проверки, варианты, `messageId` | [docs/03-checks.md](docs/03-checks.md); варианты — `data/ruleset`  |
| Тексты находок и стоп-слова                      | [docs/legal/wording-guide.md](docs/legal/wording-guide.md)         |
| Тесты, CI, Docker, Action                        | [docs/04-quality-and-delivery.md](docs/04-quality-and-delivery.md) |
| Как устроен прототип                             | [docs/prototype/BRIEF.md](docs/prototype/BRIEF.md)                 |

Если решение противоречит этим документам, остановись и спроси. Документ «под код» молча не переписывай.

## Команды

```bash
corepack pnpm install
node node_modules/playwright-core/cli.js install --no-shell chromium
corepack pnpm typecheck && corepack pnpm lint
corepack pnpm test:unit          # L0–L1, без браузера и сети
corepack pnpm test:integration   # L2: настоящий Chromium, локальные серверы, без интернета
corepack pnpm build && corepack pnpm test:e2e   # build пишет и schema/report.schema.json из zod
node dist/cli.js https://example.test --format console,json,html
node dist/cli.js report <report.json> --format html,pdf
```

Версии зависимостей запинены точно (`.npmrc`: `save-exact=true`). Новую зависимость добавляй, только если её лицензия пермиссивная (MIT, Apache-2.0, BSD, ISC, MPL-2.0). NC-, SA- и GPL-данные в поставку не попадают.

## Жёсткие правила

1. **Только пассивно.** Никаких логинов, отправки форм, перебора и обхода CAPTCHA или бот-защиты. FILE-01 и ADMIN-01 — только opt-in класс E. Навигации идут по одной с паузой ≥ 1,5 с, HTTP-пробы — не чаще 2 запросов в секунду на хост. User-Agent честный, со ссылкой на репозиторий.
2. **Никаких значений.** Значения cookies, Web Storage и TC-String не попадают в снимок, отчёт, логи и исключения — ни открыто, ни хешем. Query редактируется до `[redacted]`, кроме allowlist. `mailto:` маскируется до домена. Редактирование делает коллектор до записи.
3. **Факт, а не правовая оценка.** Пользовательские строки лежат только в `data/texts/**`. Формулировки — «beobachtet» и «nicht gefunden in …». Стоп-слова (verstößt, rechtswidrig, unzulässig, DSGVO-konform, illegal, violates…) проверяет тест. `crmCode` (`T1_…`) выводится только в JSON.
4. **Проверки — чистые функции.** `src/checks/**` импортирует только `src/core/api.ts` и типы, без Playwright, undici и `node:*` I/O. Это проверяет тест графа импортов. Уровни, gating и `crmCode` — данные (`data/ruleset`), а не код.
5. **Нераспознанный баннер → `info` «Banner nicht erkannt».** CONSENT-04 выше `info` выдают только собственные адаптеры CMP при распознавании `high`. Бот- и гео-сигналы переводят проверки в `inconclusive`, а не в находку.
6. **Тесты обязательны.** Каждый вариант проверки покрыт фикстурами `violation`, `clean` и `inconclusive` плюс контрпримером. Тест полноты реестра это проверяет. Unit- и интеграционные тесты не ходят в интернет. Живые сайты — только в `test/live/**` (по умолчанию не запускается) и в канарейке.
7. **Результаты сканов чужих сайтов не коммитятся и не публикуются.** Каталоги `canary/results/` и `dsgvo-check-report*` лежат в `.gitignore`.
8. **Git.** Не коммить и не пушь без явной просьбы.
9. **Комментарии объясняют причину.** Без номеров ревью, раундов и канареек, имён моделей, тегов владельцев, декоративных разделителей и меток удалённых решений.
10. **Доставка короткая.** Разбор и проверка входов — в TypeScript; YAML и shell содержат запуск контейнера, изоляцию и передачу отчётов в CI. В `uses:` — теги версий; образ — `ghcr.io/seed-factory/dsgvo-check:<версия из package.json>`.
11. **Тесты описывают поведение.** Имена файлов и сценариев не содержат историю ревью; однотипные случаи объединяются в таблицы без потери уникальных входов и требований правила 6.


## Как добавить проверку

Пример чистой проверки — в [contract-example.test.ts](test/unit/core/contract-example.test.ts). Шаги регистрации:

1. Создай файл `src/checks/<module>/<id>.ts` и добавь строку в `src/checks/<module>/index.ts`.
2. Добавь варианты с уровнем и `crm` (код каталога или `null`) в `data/ruleset/de-2026/<module>.yaml`, тексты в `data/texts/{de,en}/<module>.yaml`, затем выполни `corepack pnpm registry`.
3. Добавь фикстуры: для браузерной проверки — сценарии в `test/unit/checks/browser/scenarios/<id>.ts` и строку в `scenarios/index.ts`, для dns — строки в `test/unit/checks/dns/fixtures.ts`, для http — JSON в `test/fixtures/snapshots/http/<ID>/`.

Имена вариантов запланированной проверки бери из второй таблицы `docs/03-checks.md` §2.1; после `corepack pnpm registry` проверка попадает в первую.
