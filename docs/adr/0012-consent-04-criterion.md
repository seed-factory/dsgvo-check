# ADR-0012 — Критерий CONSENT-04: таблица вариантов по `CmpFacts` первого экрана

Этот документ фиксирует, при каких измеренных фактах баннер считается «без равноценного отказа на первом уровне» и какой уровень получает каждый вариант. Нужен разработке, заказчику (подпись ruleset) и аудиторам, читающим evidence.

## Статус

`Proposed` — уровни ждут подписи заказчика по вопросу 9 «Подпись таблицы уровней `ruleset/de-2026`» ([раздел 8](../consensus/README.md#8-вопросы-заказчику)). Ruleset имеет статус draft до подписи; разработку это не блокирует, потому что тесты проверяют `variant`, а не уровень. Релиз до подписи заблокирован.

## Контекст

- Спор 2:2 по блокирующему баннеру: Sol-К и Terra-К — `warning` по умолчанию до экспертного утверждения; Opus-К и Fable-К — для блокирующего баннера без отказа позиция устоялась (DSK OH Digitale Dienste Rn. 124–125, OLG Köln 6 U 80/23 от 19.01.2024, VG Hannover 10 A 5385/22 от 19.03.2025, большинство EDPB Cookie Banner TF, Type A). Неблокирующий баннер без отказа → `info` — 3:1 (Terra-К — `warning` до утверждения). Каталог ставит CONSENT-04 в P0 с кодом T1.
- Технические ошибки предложений: решение в коллекторе; `critical` без возможности согласиться на первом уровне (errata №15); `aria-modal` как доказательство блокировки; scroll-lock на внутреннем контейнере; `elementFromPoint` возвращает потомка ссылки; «×» и «Verbergen» трактовались как отказ или как принятие без чтения конфига; «цена + Abo» целиком исключал проверку.

## Решение

Решение принимает **чистая таблица в ruleset** поверх `CmpFacts` первого экрана распознанного CMP. Геометрия, hit-testing и видимость снимаются **до любого действия**, на desktop (фаза B до клика, фаза A для блокировки) и в M.

| `variant` | Условие | Уровень |
|---|---|---|
| `blocking-no-reject` | CMP `high`; блокировка измерена (overlay, scroll-lock на `html/body`, `inert`, `coveredRatio`); на первом уровне **есть** actionable-кнопка класса accept (`acceptAvailableAtFirstLayer`) и нет actionable-кнопки класса reject; «Einstellungen», «Später», «Verbergen», «×» отказом не считаются | `critical` |
| `no-choice-at-first-layer` | блокирующий первый уровень без accept и без reject (только настройки) | `info`, ручная оценка |
| `close-means-accept` | «×» = принять, по прочитанному конфигу CMP | `critical` |
| `reject-not-actionable` | кнопка reject есть, но вне первого экрана или не кликабельна без скролла | `warning` |
| `reject-ineffective` | клик сделан, `verify` не подтвердил отказ (`origin: action` → `stored`, `decision.responded`) | `warning` |
| `consent-without-action` | состояние CMP `granted` без клика: `consent-state.origin: default/stored`, `ready`, нет `SCAN-BOTMODE` | `warning` |
| `reject-as-link` | отказ оформлен ссылкой, а не кнопкой (EDPB TF Type C) | `info`, ручная оценка |
| `nonblocking-no-reject` | баннер не блокирует, отказа на первом уровне нет | `info`, ручная оценка (3:1) |
| `pur-abo` | обнаружен платный вариант; флаг, не выключатель остальных вариантов | `info`, ручная оценка |
| `banner-not-recognized` / `cmp-not-supported` | нет адаптера, CMP `medium`, версия вне диапазона | `info`, статус `inconclusive`, `crmCode: null`; `locked`: уровень и `gating: false` не меняют ни ruleset, ни overrides, такой override — ошибка конфига `invalid-input` |

- Метрики равноценности (площади, контраст, тип элемента) — только evidence, на уровень не влияют.
- Гео- или бот-режим → `inconclusive`. При повторе по снимку расхождение с `plan.click` даёт limitation `lexicon-changed-since-scan`.
- Evidence `cmp`: `buttons[{role, name, vendorRole?, box, visibleAtFirstScreen, actionableAtFirstScreen, contrast}]` — факты адаптера; `kind` и `kindConfidence` — результат `classifyFirstLayer` с версией лексикона; `blocking {overlay, scrollLock, inert, coveredRatio, method}`, `viewport`, `plan.click`, производное `acceptAvailableAtFirstLayer`; скриншот области баннера ([ADR-0015](0015-evidence-minimisation.md)).

## Рассмотренные варианты

| Вариант | Плюс | Минус |
|---|---|---|
| Таблица в ruleset, `critical` для блокирующего без отказа (выбран) | Правовая линия устоялась; вердикт только от адаптеров `high`; уровни — данные, подпись заказчика | Требует подписи до релиза |
| `warning` по умолчанию до экспертизы (Sol-К, Terra-К) | Осторожнее | CONSENT-04 — P0 с T1; `warning` при `--fail-on critical` делает самую обсуждаемую проверку негейтящей; требование «до утверждения» выполняется статусом draft |
| `blocking-no-reject` без условия accept (первая редакция D13) | Проще | Экран «только настройки» дал бы ложный `critical`: там нельзя ни согласиться, ни отказаться (errata №15) |
| `reject-as-link` → `warning` (Fable-К) | Ближе к EDPB Type C | «Достаточная визуальная поддержка» ссылки детектом не устанавливается; заказчик может поднять уровень в таблице |
| Решение в коллекторе после клика | Проще код | Не воспроизводится по снимку; `locator.click()` прокручивает и портит первый экран |

## Последствия

- Первый экран снимается до клика в B и отдельно в M: геометрия и `page.screenshot()` текущего viewport до любого действия, затем обрезка; `locator.screenshot()` не используется — он прокручивает элемент. Blocking измеряется в A.
- `de-strict`-профиль в 1.0 не делается; заказчик меняет значения в `ruleset/de-2026.yaml`.
- ⚠ проверить, факты 10, 11, 13 (DSK OH v1.2 и Rn. 124–125, в том числе что Rn. 125 говорит о первом уровне без согласия; Rechtskraft OLG Köln и VG Hannover; текст EDPB TF Type C) проверяются до подписи ruleset.
- Приёмка: 0 известных ложных `critical` на CMP-лаборатории и корпусе.

## Ссылки

- Консенсус: [D13, D20](../consensus/README.md#2-итоговые-решения); [§3 D13](../consensus/README.md#3-подробности-по-спорным-точкам-и-точкам-изменённым-меньшинством); [CONSENT-04 в §4](../consensus/README.md#4-сводная-спецификация-проверок); [§5.4–5.5](../consensus/README.md#54-fingerprint-подавления-baseline); ошибки 1, 28, 47, 55, 85; факты 10–13; вопрос 9; [errata №11, 14, 15, 31, 34](../consensus/round-4/errata.md).
- Критика: [Sol-К §4.4](../consensus/round-3/codex-gpt-6.1-sol_critique.md), [Opus-К D13](../consensus/round-3/claude-opus-5.5_critique.md), [Fable-К D13](../consensus/round-3/claude-fable-5.1_critique.md), [Terra-К D13](../consensus/round-3/codex-gpt-6.1-terra_critique.md); [votes-matrix D13](../consensus/round-3/votes-matrix.md#d13).
- Предложения: [Opus-П §4.4, §4.7](../consensus/round-2/claude-opus-5.5_proposal.md), [Fable-П §4](../consensus/round-2/claude-fable-5.1_proposal.md).
- Ресёрч: [legal-basis-map §2.1](../01-research/legal-basis-map.md); [regulatory-landscape §3–4](../01-research/regulatory-landscape-2026.md); [browser-automation §5.1–5.4](../01-research/browser-automation.md).
