# ADR-0005 — Модель результата: status, severity, confidence, diagnostics

Этот документ фиксирует три независимые оси результата проверки и отдельную сущность диагностики. Нужен разработке, авторам текстов и потребителям JSON: от него зависят гейт, HTML и CRM-экспорт.

## Статус

`Accepted` — D04, единогласно. Дата: 2026-10-30.

## Контекст

- Ресёрч раунда 1 и часть предложений использовали `pass/fail`, а проблемы измерения (бот-режим, гео, нераспознанный баннер) оформляли как находки `warning` с кодами `SCAN-*`. Такая находка роняла `--fail-on warning` из-за ограничения сканера, а не дефекта сайта.
- «Нет находки» не означает «соответствует»: покрытие страниц и фаз ограничено, часть сети не наблюдаема (SW, pagehide-beacons, server-side tagging).
- Уверенность сопоставления (каталог, версия CMP, алиасы в DSE) и тяжесть факта — разные величины; смешение даёт ложные `critical`.

## Решение

| Ось | Значения | Смысл |
|---|---|---|
| `status` проверки | `completed / partial / inconclusive / not_applicable / skipped / error` | Как прошло измерение; `pass`/`fail` нет |
| `severity` находки | `critical / warning / info` | Уровень по ruleset; `info` никогда не гейтит |
| `confidence` находки | `high / medium / low` | Уверенность технического сопоставления |

- Кэп уверенности в assess: `medium` → не выше `warning`, `low` → не выше `info`. После кэпа фильтра по confidence в гейте нет (`--min-confidence` отозван).
- `diagnostics[]` — отдельная сущность без severity: `code`, `affects[]`, `evidenceIds[]`. Коды: `SCAN-GEO`, `SCAN-BOTMODE`, `SCAN-BLOCKED`, `SCAN-UNREACHABLE`, `SCAN-THROTTLED`, `SCAN-TIMEOUT`, `SCAN-SANDBOX-OFF`, `SCAN-PRIVATE-REQUEST-BLOCKED`. Диагностика не гейтит (кроме `--strict`) и в CRM не идёт.
- `inconclusive` — «данных недостаточно»: нераспознанный баннер, бот- или гео-сигнал, неполный документ, PDF-политика, неподтверждённый отказ (только default-denied). `not_applicable` — неприменима целиком (VULN-02 — только без WP-компонентов, JS-библиотек и Next.js/Nuxt). `skipped` — выключена или пропущена по зависимости (`tls-blocked`). `error` — сбой исполнения.
- Одно наблюдение даёт одну гейтящую находку; остальные связываются через `evidenceIds` и `related[]` ([ADR-0008](0008-fingerprint-suppressions-baseline.md)).
- `CheckResult`: `id`, `status`, `reason`, `limitations[]`, `coverage`, `durationMs`. Coverage показывает «geplant / beobachtet / auswertbar».

## Рассмотренные варианты

| Вариант | Плюс | Минус |
|---|---|---|
| Три оси + `diagnostics[]` (выбран) | Ограничение измерения не красит CI; уровень и уверенность разделены | Больше полей в схеме, нужен кэп в assess |
| `pass/fail` на проверку | Привычно для JUnit | «pass» читается как «соответствует»; противоречит ТЗ про правовые выводы |
| `SCAN-*` как находки `warning` (Fable-П, отозвано) | Одна сущность | Роняет `--fail-on warning` из-за бот-режима; попадает в CRM |
| Фильтр `--min-confidence` в гейте | Гибко для пользователя | Скрытый выключатель находок; кэп в assess даёт тот же эффект явно |

## Последствия

- Каждая строка таблицы кодов возврата ([ADR-0006](0006-exit-codes-and-gate.md)) ссылается на эти статусы.
- Для `inconclusive` в evidence сохраняются измеренные факты для ручной проверки.
- JUnit — по маппингу [§5.2 консенсуса](../consensus/README.md#52---fail-on-и-коды-012): `<failure>` — учитываемые находки, `<error>` — `check-error`, `<skipped>` — `inconclusive`, `not_applicable`, `skipped`; подавленные, известные по baseline и `info`-находки — в `<system-out>`. HTML показывает `limitations` и «Messumgebung».
- Новый код диагностики или `status` — minor и major соответственно ([ADR-0007](0007-report-schema.md)).

## Ссылки

- Консенсус: [D04](../consensus/README.md#2-итоговые-решения); [§5.1](../consensus/README.md#51-модель-результата); ошибки 29, 79, 86 в [разделе 6](../consensus/README.md#6-ошибки-найденные-в-ходе-консенсуса); кандидат ADR-005.
- Критика: все четыре -К по D04, в частности [Opus-К §2.2 (ошибка Fable №1)](../consensus/round-3/claude-opus-5.5_critique.md), [Sol-К §4.5](../consensus/round-3/codex-gpt-6.1-sol_critique.md); [votes-matrix D04](../consensus/round-3/votes-matrix.md#d04).
- Предложения: [Opus-П §5.6](../consensus/round-2/claude-opus-5.5_proposal.md), [Fable-П §5](../consensus/round-2/claude-fable-5.1_proposal.md), [Terra-П §5](../consensus/round-2/codex-gpt-6.1-terra_proposal.md).
- Ресёрч: [R1-полнота](../consensus/round-1/claude-fable_completeness-critic.md), [R1-red-team §3, §6 п. 3](../consensus/round-1/codex-gpt-6.1-terra_redteam-qa.md).
