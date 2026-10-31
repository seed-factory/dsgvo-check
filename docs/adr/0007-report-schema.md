# ADR-0007 — JSON-схема отчёта

Этот документ фиксирует, чем описана схема отчёта, как она версионируется и что обязано быть валидным даже при отказе сканера. Нужен разработке, интеграторам CRM заказчика и авторам репортеров.

## Статус

`Accepted` — D21 по технологии и структуре, единогласно (состав fingerprint — см. [ADR-0008](0008-fingerprint-suppressions-baseline.md)). Политика `null` для `crmCode` и коды по варианту — до этапа 1 ждут подтверждения заказчика (вопрос 6), но саму схему не блокируют. Дата: 2026-10-30.

## Контекст

- ТЗ требует стабильную схему с ID проверки, уровнем, доказательством (URL, запрос, cookie, заголовок, DNS-запись) и `crmCode` из каталога.
- Во всех предложениях обязательные поля не позволяли выдать валидный отчёт при раннем отказе; у пользовательских файлов не было версии; `crmCode` висел на проверке, хотя у VULN два кода.
- Потребители: CRM заказчика (JSON), HTML/JUnit/Summary (генерируются из того же отчёта), baseline и suppressions.

## Решение

- **Источник схемы** — zod 4 (`z.toJSONSchema()`, draft 2020-12), схема коммитится в `schema/` (`schema/report.schema.json`, как в `package.json`), CI проверяет дрейф; независимая валидация — Ajv 8 (`ajv/dist/2020`) в контрактных тестах на каждом golden- и L2/L3-отчёте.
- **Верхний уровень:** `schemaVersion`, `tool {name, version}`, `ruleset {version (CalVer), rechtsstand, profile: "de-2026"}`, `datasets[]`, `scan`, `checks[]`, `findings[]`, `diagnostics[]`, `evidence[]`, `legalContext`, `summary {counts, exitCode, exitReasons[]}`, `disclaimer`. У каждого элемента `datasets[]` — имя, дата, sha256, лицензия и `attribution` ([ADR-0013](0013-service-catalog-and-data-licenses.md)).
- **Дискриминатор `scan.status`:** `complete / partial / failed`. При `failed` обязательны только `schemaVersion`, `tool`, `scan {status, target, startedAt, failure {code, message}}`, `summary {exitCode, exitReasons}`, `disclaimer`.
- **`evidence[]`** на верхнем уровне, каждый сетевой факт хранится один раз; находки ссылаются через `evidenceIds` (≤ 20, флаг `evidenceTruncated`). `evidence.type` — открытый enum: `request`, `cookie`, `storage`, `header`, `dns`, `tls`, `cmp`, `consent-state`, `document`, `text-match`, `component`, `mixed-content`, `screenshot`.
- **`crmCode`:** `string | null`, из маппинга `(checkId, variant)` в `data/crm/mapping.yaml`; `null` для P2 до справочника, `banner-not-recognized` и несопоставленных вариантов. Только в JSON; в описании схемы — «interne Taxonomie des Auftraggebers, keine rechtliche Einordnung».
- **Версии:** `schemaVersion` — semver, независимый от версии CLI. Minor: новое необязательное поле, `checkId`, `variant`, `evidence.type`, код диагностики. Major: удаление или переименование, смена типа, новое значение закрытого enum (`severity`, `status`), смена семантики кодов возврата. Публикуемая схема не закрывает `additionalProperties`; внутренние тесты используют строгий вариант.
- Конфиг `.dsgvo-check.yaml`, `suppressions.yaml`, baseline — поле `version: 1`; миграции появляются со второй версией формата (`baseline migrate` — бэклог, [ADR-0008](0008-fingerprint-suppressions-baseline.md)).

## Рассмотренные варианты

| Вариант | Плюс | Минус |
|---|---|---|
| zod 4 → JSON Schema + Ajv (выбран) | Одна библиотека для конфига, отчёта и `data/*.yaml`; лучшие ошибки для людей | Конвертация требует контроля дрейфа (закрыто Ajv-тестами) |
| TypeBox | Схема и есть JSON Schema | Хуже сообщения об ошибках конфига, меньше экосистема |
| valibot | Лёгкий | Нет причин перед zod; конвертер отдельным пакетом |
| Строгая схема с закрытыми enum «неизвестное = ошибка» (Terra-П) | Жёсткий контракт | Новый `evidence.type` ломал бы потребителей; выбраны открытые строки с реестром |
| Одна версия для CLI и схемы | Проще | Релиз текстов или каталога заставлял бы менять версию схемы |

## Последствия

- Каждый путь к коду `2` из таблицы D03 проверяется контрактным тестом на валидность отчёта по Ajv, в том числе минимального `failed`; `summary.exitCode` в JSON — окончательный, после репортёров ([ADR-0006](0006-exit-codes-and-gate.md)).
- Потребитель обязан игнорировать неизвестные поля и `evidence.type` — правило закреплено в README.
- L0-тест: строк `T[0-9]_` нет в консоли, HTML, PDF, JUnit и Summary.
- Смена маппинга `crmCode` — minor-релиз с записью в CHANGELOG.

## Ссылки

- Консенсус: [D07, D21](../consensus/README.md#2-итоговые-решения); [§5.1, §5.3, §5.6](../consensus/README.md#5-ключевые-контракты); ошибки 4, 5, 8, 30, 53, 67; вопрос 6; [errata №24, 27, 28, 50](../consensus/round-4/errata.md).
- Критика: [Opus-К §4.7–4.8](../consensus/round-3/claude-opus-5.5_critique.md), [Fable-К §4.1](../consensus/round-3/claude-fable-5.1_critique.md), [Sol-К D21](../consensus/round-3/codex-gpt-6.1-sol_critique.md); [votes-matrix D21](../consensus/round-3/votes-matrix.md#d21).
- Предложения: [Opus-П §5.2–5.4](../consensus/round-2/claude-opus-5.5_proposal.md), [Sol-П §5 «Черновик схемы»](../consensus/round-2/codex-gpt-6.1-sol_proposal.md), [Fable-П §5](../consensus/round-2/claude-fable-5.1_proposal.md).
- Ресёрч: [engineering §3.1–3.4](../01-research/engineering-ci-distribution.md); [R1-red-team §3](../consensus/round-1/codex-gpt-6.1-terra_redteam-qa.md).
