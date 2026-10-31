# ADR-0004 — Конвейер и контракт проверки

Этот документ задаёт поток данных скана и форму модуля проверки, чтобы новая проверка добавлялась без правок ядра (требование ТЗ) и тестировалась без браузера. Нужен разработке ядра и авторам проверок.

## Статус

`Accepted` — D05, большинство (Terra-К за build-time manifest; тест полноты даёт ту же гарантию). Дата: 2026-10-30.

## Контекст

- ТЗ: «новая проверка добавляется без правок ядра», «проверки — независимые модули», фикстуры на каждую проверку.
- Во всех четырёх предложениях решение CONSENT-04 принималось в коллекторе, классификация запекалась в снимок, а LEGAL-01 сам искал DSE для PRIV-* — зависимость проверки от проверки и невозможность повтора по снимку с новым каталогом.
- Без статического объявления вариантов нельзя вычислить `maxSeverity` для гейта ([ADR-0006](0006-exit-codes-and-gate.md)) и проверить полноту текстов, ruleset и `crmCode`.

## Решение

Цепочка: **коллекторы → снимок → `derive` → проверки → assess → gate → репортеры**.

1. **Коллекторы** (browser, http, tls, dns) пишут сырые, уже отредактированные факты ([ADR-0015](0015-evidence-minimisation.md)) и раздел `plan`: выбранные страницы с причинами, нажатая кнопка `plan.click`, запрошенные пробы. Безопасные признаки `request.features` (`identifier {kind, matchesStoredIdentifier}`, `eventType`, `consentSignal`) извлекаются до удаления значений и сохраняются в снимке и evidence с `parserVersion` и `observationSource`; пересчёт по снимку обещан только для сохранённых признаков. Поиск и извлечение документов (`documents`: Impressum, DSE с manifest полноты и происхождением фрагментов) — функция коллектора, независимая от исхода отказа: DSE — в фазе A без кликов, дополнение в B.
2. **`derive`** — чистая классификация по каталогу сервисов и cookie-базе; пересчитывается при `--from-snapshot` (имя флага выбирается на этапе 1: `--from-snapshot` или `--from-artifacts`, [ОВ-23 архитектуры](../02-architecture.md#открытые-вопросы)), поэтому снимок не устаревает вместе с каталогом.
3. **Проверки** получают срез снимка по `requires` и возвращают наблюдения уровня `variant`. Уровень они не назначают.
4. **assess** ставит `severity` по ruleset `(checkId, variant)`, применяет кэп `confidence`, overrides конфига и routing-дедупликацию.
5. **gate** — чистая функция, вычисляет предварительный код и `exitReasons[]` до сериализации.
6. **Репортеры** работают только с готовым отчётом; JSON пишется первым и после остальных репортёров перезаписывается с окончательным кодом ([ADR-0006](0006-exit-codes-and-gate.md)).

Контракт модуля:

```ts
interface CheckDefinition {
  id: CheckId;                       // "CONSENT-04"
  requires: SnapshotSlice[];         // какие разделы снимка нужны
  variants: readonly VariantDecl[];  // статически: variant, variantGroup
  planProbes?: (ctx) => ProbeSpec[]; // только декларативные дополнительные запросы
  run(slice: Slice): Observation[];  // чистая функция, без I/O
}
```

- Новая проверка = папка в слое checks + строка в явном реестре + тест полноты: тексты `de` на каждый `variant` (`en` — после объявления его релизным), строка ruleset, `crmCode` или явный `null`, фикстуры violation/clean на каждый `variant`.
- Дополнительные запросы проверка описывает только `ProbeSpec`; валидатор относит их к классам O/T/E ([ADR-0014](0014-passive-mode-request-classes.md)).
- Адаптер CMP разрезан: в коллекторе — `extract(page, viewport) → CmpFacts`, `act(page, target) → ClickFact`, `verify(page) → ConsentState`; что считать reject или accept и куда кликать, решает только чистая `classifyFirstLayer(facts, lexicon)` в core, выбор пишется в `plan.click` ([ADR-0011](0011-cmp-adapters.md)).
- L0-тест графа импортов: модулю проверки недоступны Playwright и `node:*` с I/O.

## Рассмотренные варианты

| Вариант | Плюс | Минус |
|---|---|---|
| Явный реестр + тест полноты (выбран) | Ноль шагов сборки, ошибка видна в тесте, grep-able | Строка в реестре на каждую проверку |
| Build-time manifest и автообнаружение (Terra-К) | Нет ручного реестра | Лишний шаг сборки; та же гарантия уже у теста полноты |
| Runtime discovery чужого кода (плагины из `node_modules`) | Расширяемость третьими лицами | Исполнение недоверенного кода в CI; вне MVP, точка `PageProbe` — после релиза |
| Классификация в коллекторе, снимок с производными | Проще на старте | `--from-snapshot` с новым каталогом даёт старый результат; фикстуры устаревают |

## Последствия

- `--save-snapshot` и `--from-snapshot` (пара имён выбирается на этапе 1: `--save-snapshot`/`--from-snapshot` или `--save-artifacts`/`--from-artifacts`, [ОВ-23 архитектуры](../02-architecture.md#открытые-вопросы)) дают воспроизводимый прогон; L1-тесты работают на срезах без браузера.
- Пять контрактов критического пути: `Snapshot`, `CheckDefinition` с `variants`, `Ruleset`, `gate()`, схема `Report`; их alpha-версии делает прототип ([ADR-0019](0019-prototype.md)).
- Расхождение лексикона CMP при повторе по снимку даёт limitation `lexicon-changed-since-scan`.
- Цена — дисциплина статических `variants`; она окупается тестом полноты и `maxSeverity`.

## Ссылки

- Консенсус: [D05, D12, D15, D22](../consensus/README.md#2-итоговые-решения); [§5.3](../consensus/README.md#53-evidence); ошибки 1, 2, 13, 14, 62 в [разделе 6](../consensus/README.md#6-ошибки-найденные-в-ходе-консенсуса); кандидаты ADR-003, ADR-004; [errata №13, 16, 19, 24, 60](../consensus/round-4/errata.md).
- Критика: [Opus-К §4.1–4.4](../consensus/round-3/claude-opus-5.5_critique.md), [Sol-К D05, §4.10](../consensus/round-3/codex-gpt-6.1-sol_critique.md), [votes-matrix D05](../consensus/round-3/votes-matrix.md#d05).
- Предложения: [Opus-П §2.3–2.5](../consensus/round-2/claude-opus-5.5_proposal.md), [Fable-П §2](../consensus/round-2/claude-fable-5.1_proposal.md), [Sol-П §2](../consensus/round-2/codex-gpt-6.1-sol_proposal.md).
- Ресёрч: [engineering §1.3–1.4](../01-research/engineering-ci-distribution.md).
