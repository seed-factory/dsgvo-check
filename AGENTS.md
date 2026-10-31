# AGENTS.md — правила для агентов, которые работают с кодом dsgvo-check

dsgvo-check — пассивный CLI-сканер на TypeScript + Playwright. Он ищет признаки нарушений DSGVO/TDDDG/DDG и базовые проблемы безопасности на сайтах, а по найденному роняет CI. Сейчас в репозитории прототип (`docs/prototype/`) и утверждённые документы релиза 1.0.

## Где правда

Порядок важности: явное решение заказчика → [ТЗ](specs/dsgvo-check_TZ.md) → [каталог проверок](specs/dsgvo-check_katalog-proverok.md) → [консенсус](docs/consensus/README.md) → остальные документы.

| Нужно                                            | Документ                                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Что строим и почему                              | [docs/00-brief.md](docs/00-brief.md)                                                              |
| Контракты, модули, поля                          | [docs/02-architecture.md](docs/02-architecture.md), консенсус §5                                  |
| Поведение каждой проверки, варианты, `messageId` | [docs/03-checks.md](docs/03-checks.md); реестр §2.1 — канон                                       |
| Тексты находок и стоп-слова                      | [docs/legal/wording-guide.md](docs/legal/wording-guide.md)                                        |
| Тесты, CI, Docker, Action                        | [docs/04-quality-and-delivery.md](docs/04-quality-and-delivery.md)                                |
| Что делать дальше                                | [docs/05-plan.md](docs/05-plan.md)                                                                |
| Как устроен прототип                             | [docs/prototype/CONTRACTS.md](docs/prototype/CONTRACTS.md), [STATUS.md](docs/prototype/STATUS.md) |

Если решение противоречит этим документам, остановись и спроси. Документ «под код» молча не переписывай.

## Команды

```bash
corepack pnpm install
node node_modules/playwright-core/cli.js install --no-shell chromium
corepack pnpm typecheck && corepack pnpm lint
corepack pnpm test:unit          # L0–L1, без браузера и сети
corepack pnpm test:integration   # L2: настоящий Chromium, локальные серверы, без интернета
corepack pnpm build && corepack pnpm test:e2e
corepack pnpm schema:check       # JSON Schema отчёта совпадает с zod-схемой
node dist/cli.js https://example.de --format console,json,html
```

Версии зависимостей запинены точно (`.npmrc`: `save-exact=true`). Новую зависимость добавляй, только если её лицензия пермиссивная (MIT, Apache-2.0, BSD, ISC, MPL-2.0). NC-, SA- и GPL-данные в поставку не попадают.

## Жёсткие правила

1. **Только пассивно.** Никаких логинов, отправки форм, перебора и обхода CAPTCHA или бот-защиты. FILE-01 и ADMIN-01 — только opt-in класс E. Навигации идут по одной с паузой ≥ 1,5 с, HTTP-пробы — не чаще 2 запросов в секунду на хост. User-Agent честный, со ссылкой на репозиторий.
2. **Никаких значений.** Значения cookies, Web Storage и TC-String не попадают в снимок, отчёт, логи и исключения — ни открыто, ни хешем. Query редактируется до `[redacted]`, кроме allowlist. `mailto:` маскируется до домена. Редактирование делает коллектор до записи.
3. **Факт, а не правовая оценка.** Пользовательские строки лежат только в `data/texts/**`. Формулировки — «beobachtet» и «nicht gefunden in …». Стоп-слова (verstößt, rechtswidrig, unzulässig, DSGVO-konform, illegal, violates…) проверяет тест. `crmCode` (`T1_…`) выводится только в JSON.
4. **Проверки — чистые функции.** `src/checks/**` импортирует только `src/core/api.ts` и типы, без Playwright, undici и `node:*` I/O. Это проверяет тест графа импортов. Уровни, gating и `crmCode` — данные (`data/ruleset`, `data/crm`), а не код.
5. **Нераспознанный баннер → `info` «Banner nicht erkannt».** CONSENT-04 выше `info` выдают только собственные адаптеры CMP при распознавании `high`. Бот- и гео-сигналы переводят проверки в `inconclusive`, а не в находку.
6. **Тесты обязательны.** Каждый вариант проверки покрыт фикстурами `violation`, `clean` и `inconclusive` плюс контрпримером. Тест полноты реестра это проверяет. Unit- и интеграционные тесты не ходят в интернет. Живые сайты — только в `test/live/**` (по умолчанию не запускается) и в канарейке.
7. **Результаты сканов чужих сайтов не коммитятся и не публикуются.** Каталоги `canary/results/` и `dsgvo-check-report*` лежат в `.gitignore`.
8. **Git.** Не коммить и не пушь без явной просьбы.

## Как добавить проверку

Шаги — в [CONTRACTS.md](docs/prototype/CONTRACTS.md), раздел про регистрацию проверки:

1. Создай файл `src/checks/<module>/<id>.ts` и добавь строку в `src/checks/<module>/index.ts`.
2. Добавь варианты в `data/ruleset/de-2026/<module>.yaml`, тексты в `data/texts/{de,en}/<module>.yaml` и маппинг в `data/crm/<module>.yaml`.
3. Положи фикстуры в `test/fixtures/snapshots/<module>/<ID>/`.

Имена вариантов бери из реестра `docs/03-checks.md` §2.1.
