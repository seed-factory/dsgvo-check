# ADR-0018 — Тулчейн и структура репозитория

Этот документ фиксирует версии инструментов сборки, тестов и линтинга, а также раскладку репозитория. Нужен разработке на этапе 0 (install- и build-smoke) и всем, кто ставит проект локально.

## Статус

`Accepted` — D06: один пакет — единогласно; без workspace — 2:1:1 (против workspace Opus-К и Terra-К, Sol-К нейтрален, Fable-К за), решение модератора по YAGNI. D07 — единогласно; сочетание версий подтверждается smoke на этапе 0 (⚠ проверить, факт 6). Дата: 2026-10-30.

## Контекст

- Платформа — TypeScript + Playwright ([ADR-0001](0001-typescript-playwright.md)). На 2026-10-30: Node 26 — Active LTS с 28.10.2026, Node 24 — Maintenance до 30.04.2028, Node 22 уходит в EOL 30.04.2027 — через полгода после релиза; undici 8 требует Node ≥ 22.19.
- TypeScript 7.0.2 — нативный `tsc` на Go; пакет экспортирует только `./unstable/*`, стабильного JS API нет до 7.1; typescript-eslint 8.72 требует `typescript <6.1.0` и с TS 7 не работает. pnpm: `latest` — 12.16.1 (27.10.2026), ветка 12 переписана на Rust и существует два месяца (12.0.0 — 26.08.2026); `latest-11` — 11.28.9. Прототип уже пинит `pnpm@12.16.1` в `packageManager`. Corepack не поставляется с Node ≥ 25 (подтверждено 30.10.2026 по документации и release notes Node.js 25.0.0, факт 32), а CI-матрица включает Node 26.
- Ресёрч R1 предлагал `engines >=22.12` и pnpm-workspace с приватными `fixture-server` и `test-utils`; без публикации этих пакетов workspace выгоды не даёт.

## Решение

| Компонент | Версия | Примечание |
|---|---|---|
| Node.js | `engines >= 24`; CI-матрица 24 и 26 | образ и Action на 24 |
| TypeScript | 7.0.x, `tsc` для typecheck и emit, `isolatedDeclarations` | TS 6.0 в запасе, если понадобится typescript-eslint или TS API |
| Пакетный менеджер | pnpm 12.16.1 с lockfile, пин через `packageManager`; фолбэк 11.28.9, если install-smoke этапа 0 провалится | `minimumReleaseAge` 1 день, `strictDepBuilds`, `blockExoticSubdeps` явно в конфиге. Установка не опирается на Corepack: в CI — `pnpm/action-setup` по `packageManager` (рекомендация ресёрча); способ для Node 26 и сборки образа подтверждает install-smoke (факт 32); `corepack pnpm` работает только на Node 24 |
| Тесты | Vitest 5; fixture-server в своём netns на 80/443, dns2, тест-CA, `--host-resolver-rules`; L2 в закрытой сети без внешнего выхода | уровни L0–L4 — D23 |
| Линт и формат | Biome 2.6 плюс oxlint-tsgolint (`no-floating-promises`, `no-misused-promises`) | typescript-eslint несовместим с TS 7 |
| Схема | zod 4 → JSON Schema 2020-12, Ajv 8 | [ADR-0007](0007-report-schema.md) |
| Браузер и HTTP | `playwright-core` 1.64.x точный пин (Chrome for Testing 156), undici 8 | версии пакета и браузера связаны |
| Сборка | без бандлера, emit через `tsc` | tsdown — запасной путь, если `.d.ts` emit TS 7 неполон |
| Лицензии | allowlist зависимостей и наборов данных в CI | [ADR-0013](0013-service-catalog-and-data-licenses.md) |

**Репозиторий:** один публикуемый npm-пакет, один `package.json`, без pnpm-workspace; `test/fixture-server` и `test/utils` — обычные каталоги. `action.yml` в корне (требование Marketplace), рядом seccomp-профиль образа. Раскладка `src/` по слоям конвейера — core, collectors (browser, http, tls, dns), cmp, checks с явным реестром, report, cli — и `data/` (каталог, CMP-лексиконы, `ruleset/de-2026.yaml`, `routing.yaml`, `crm/mapping.yaml`, `texts/{de,en}.yaml`, `legal/`) следует [ADR-0004](0004-pipeline-and-check-contract.md); конкретные имена каталогов — предложение автора, не согласовано. Отдельные репозитории: `example` (красная и зелёная сборка, все коды `0/1/2`) и приватная канарейка; GitLab Catalog-компонент — после релиза.

## Рассмотренные варианты

| Вариант | Плюс | Минус |
|---|---|---|
| Один пакет без workspace (выбран) | Минимальный конфиг релизов; тест-инфраструктура изолируется через `files` и devDeps | Фикстур-сервер нельзя переиспользовать как пакет — он и не публикуется |
| Workspace с приватными пакетами (ресёрч R1, Fable-К) | Естественная изоляция devDeps | Лишний слой без публикации; усложняет release-please |
| Монорепо `core/checks/cli/sdk`, всё публикуется | Плагины третьих лиц | Публичный API пакетов с первого дня — преждевременно |
| Node `>=22.12` (ресёрч R1) | Шире охват | undici 8 требует 22.19; EOL Node 22 через полгода после релиза — мажор ради `engines` |
| pnpm 11.28.9 (`latest-11`) — фолбэк | Зрелая ветка; `minimumReleaseAge`, `strictDepBuilds`, `blockExoticSubdeps` по умолчанию | Второй тулчейн рядом с прототипом на 12.16.1; включается, только если smoke 12 провалится |
| ESLint + typescript-eslint | Привычно | Несовместим с TS 7; Biome + tsgolint закрывают нужные правила |
| Бандлер (tsup, tsdown) | Один файл | Не нужен для CLI; `tsc` достаточно, tsdown — запасной путь, если `.d.ts` emit TS 7 неполон |

## Последствия

- Этап 0 начинается с install- и build-smoke: TS 7.0 + Biome 2.6 + oxlint-tsgolint + `playwright-core` 1.64 одной установкой с pnpm 12.16.1 на Node 24 и 26 (установка pnpm без Corepack); при провале — фолбэк 11.28.9. Риск молодой ветки 12 учтён фолбэком, а не отказом.
- Renovate (кандидат ADR-033 — предложение модератора к этапу 4): одна группа `playwright-core` + `ARG` Dockerfile + digest базового образа; Playwright и security-обновления без задержки.
- L0 в CI: линты, реестр и тест полноты, стоп-слова, граф импортов, лицензии.
- Переход на Node 26 как минимум для образа — после релиза.

## Ссылки

- Консенсус: [D06, D07, D23](../consensus/README.md#2-итоговые-решения); ошибки 56, 78; факты 6, 32; кандидаты ADR-030, ADR-031; [errata №9, 57](../consensus/round-4/errata.md). Прототип: [BRIEF, «Стек и версии»](../prototype/BRIEF.md).
- Критика: [Opus-К D06, D07](../consensus/round-3/claude-opus-5.5_critique.md), [Sol-К D06, D07](../consensus/round-3/codex-gpt-6.1-sol_critique.md), [Terra-К D06, D07](../consensus/round-3/codex-gpt-6.1-terra_critique.md), [Fable-К D06](../consensus/round-3/claude-fable-5.1_critique.md); [votes-matrix D07](../consensus/round-3/votes-matrix.md#d07).
- Предложения: [Opus-П §2.7](../consensus/round-2/claude-opus-5.5_proposal.md), [Fable-П §10 «Платформа»](../consensus/round-2/claude-fable-5.1_proposal.md).
- Ресёрч: [engineering §0, §1, §2, §8](../01-research/engineering-ci-distribution.md); [R1-полнота (Node, undici)](../consensus/round-1/claude-fable_completeness-critic.md).
