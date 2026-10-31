# ADR-0011 — Адаптеры CMP и роль `@duckduckgo/autoconsent`

Этот документ фиксирует, как сканер распознаёт баннер, читает состояние согласия и нажимает «Ablehnen», и где проходит граница между собственным кодом и сторонней библиотекой. Нужен разработке адаптеров и авторам CONSENT-03/04/05.

## Статус

`Accepted` — D12, единогласно. Дата: 2026-10-30.

## Контекст

- Каталог называет семь CMP в порядке реализации (в скобках — число находок): Borlabs (12), Cookiebot (4), Complianz (4), Usercentrics (1), CCM19 (2), Real Cookie Banner (1), CookieHub (1). Первые три дают 20 из 25 CMP-находок.
- ТЗ запрещает ложный CONSENT-04 на неизвестном баннере: «не распознал — пиши `info` „Banner nicht erkannt“».
- `@duckduckgo/autoconsent` 17.1.0 (MPL-2.0, 913 правил) умеет детект и opt-out, но его `optOut` у Borlabs идёт по цепочке «accept only essential → save → close», у Cookiebot — через API `Cookiebot.withdraw()`, а `prehideSelectors` косметически скрывают баннер. Для вердикта о первом уровне это непригодно.
- Во всех предложениях классификация кнопок принималась в коллекторе; первая редакция контракта D12 (`firstLayer`, `reject`, `accept` в адаптере) повторяла эту ошибку (errata №13). `locator.click()` прокручивает элемент и портит измерение первого экрана.

## Решение

- **Семь собственных адаптеров** — TS-модули в порядке каталога. Контракт — три операции без решений:
  - `extract(page, viewport) → CmpFacts` — распознавание и версия; кнопки с ролью, accessible name, геометрией, actionability, контрастом и `vendorRole` (роль по разметке или конфигу CMP — факт, а не класс); блокировка `overlay / scrollLock / inert / coveredRatio`; `ConsentState`; гео- и бот-сигналы;
  - `act(page, target) → ClickFact` — клик по элементу, который выбрала core;
  - `verify(page) → ConsentState` — сразу после действия и после reload.
- **Решение — только в core.** Что считать reject, accept, settings, блокирует ли баннер и куда кликать, решает чистая `classifyFirstLayer(facts, lexicon)` ([ADR-0012](0012-consent-04-criterion.md)); выбор пишется в `plan.click`. `reject` и `accept` — классы кнопок в её результате, а не методы адаптера.
- JS-API CMP только читаем (`Cookiebot.consent`, `__ucCmp`, `cmplz_*`, `__tcfapi('ping')`), никаких API-мутаторов. Клик — только по однозначному элементу класса reject/accept, `locator.click()` без `force`.
- CMP распознан с `high` = ≥ 2 независимых признака (скрипт, DOM-контейнер, cookie-префикс, JS-API). Уверенность в CMP и в функции кнопки считаются раздельно (`recognitionConfidence`, `kindConfidence`).
- **Состояние вместо названий фаз:** `consent-state {source: api/cookie/tcf, ready: stub/loading/ready, categories: denied/granted/partial/unknown, origin: default/stored/action/special-branch, scope, decision {responded, method}}`. Отказ подтверждается по состоянию, а не по отсутствию трекинга и не по закрытию UI: CMP `ready`; после нашего клика `origin: action` и `decision.responded: true` (например, Cookiebot `hasResponse` и `declined`); все необязательные категории `denied` или consent-cookie `denied`; после reload — `origin: stored`. Исходное `default`-состояние с `denied` отказом не считается.
- **autoconsent** — закреплённая немодифицированная зависимость `@duckduckgo/autoconsent@17.1.0`, инжектируется после окна фазы A. Используется только для «CMP X erkannt, nicht unterstützt» и как второе мнение классификатора кнопок. Его правила не копируются в наш каталог и не модифицируются; детект работает read-only на собственных правилах autoconsent; `optOut`, `optIn`, cosmetic и любые действия, меняющие страницу, выключены (точный конфиг 17.1.0 — ⚠ проверить, факт 30). Селекторы адаптеров пишем сами (§ 87a UrhG).
- **MPL-2.0.** Немодифицированность обязанностей распространителя не снимает: `THIRD_PARTY_NOTICES` в npm-пакете и OCI-образе несёт текст лицензии и ссылку на исходный код точной версии ([ADR-0017](0017-distribution.md)).
- Собственная эвристика для неизвестных баннеров выдаёт только `info` «Banner nicht erkannt» и статус `inconclusive`; вердикт по эвристике возможен позже только при precision ≥ 0,95 на размеченном корпусе.

## Рассмотренные варианты

| Вариант | Плюс | Минус |
|---|---|---|
| Свои адаптеры `extract / act / verify` + autoconsent только для детекта (выбран) | Контроль над семантикой первого уровня; решение в core тестируется в L1 и повторяется по снимку; вердикты только от `high` | 7 адаптеров — 8–9 чд плюс лаборатория и дрейф |
| Адаптер с `firstLayer`, `reject`, `accept` (первая редакция D12) | Меньше слоёв | Решение об отказе снова в коллекторе — вне L1 и повтора по снимку (errata №13) |
| autoconsent как источник вердикта и opt-out | Готовые 913 правил | opt-out через второй уровень, API и косметику; MPL-правки и копирование правил — лицензионный риск |
| Consent-O-Matic как основа | MIT, есть Borlabs/Cookiebot/Complianz | Нет CCM19, RCB, CookieHub; расширение браузера, а не библиотека; остаётся референсом селекторов |
| Эвристика с порогом score ≥ 0,8 как вердикт (ресёрч R1) | Шире покрытие | Противоречит ТЗ про неизвестный баннер |
| Отказ через API CMP (`withdraw()`) | Надёжно | Не то, что делает посетитель; измерение UI теряется |

## Последствия

- CMP-лаборатория на лицензированных установках (сначала Borlabs, Cookiebot, Complianz) — условия ToS и бюджет ⚠ проверить, факт 20; спайк С6 — адаптеры Borlabs и Cookiebot на этапе 0.
- Дрейф селекторов — риск 4: ночная лаборатория, версия CMP в evidence, fail-safe в `info`, autoconsent как сигнал дрейфа.
- Зависимые проверки при нераспознанном баннере получают `inconclusive`; код возврата не меняется (кроме `--strict`).
- CONSENT-05 зависит от подтверждённого состояния отказа, а не от «отсутствия трекинга» — иначе главный кейс недостижим (ошибка 12).

## Ссылки

- Консенсус: [D05, D12](../consensus/README.md#2-итоговые-решения); [§5.3 `cmp`, `consent-state`](../consensus/README.md#53-evidence); [§5.5](../consensus/README.md#55-правило-нераспознанный-баннер--info); [§5.8](../consensus/README.md#58-отчёты-csp-и-уведомления-о-лицензиях); ошибки 1, 7, 12, 17, 37, 71, 85, 88; факты 20, 30; риски 4, 12; [errata №13, 18, 49, 50](../consensus/round-4/errata.md).
- Критика: [Opus-К §4.3](../consensus/round-3/claude-opus-5.5_critique.md), [Sol-К §4.1, §4.4](../consensus/round-3/codex-gpt-6.1-sol_critique.md), [Fable-К §4.12](../consensus/round-3/claude-fable-5.1_critique.md); [votes-matrix D12](../consensus/round-3/votes-matrix.md#d12).
- Предложения: [Opus-П §4.1–4.6](../consensus/round-2/claude-opus-5.5_proposal.md), [Fable-П §4](../consensus/round-2/claude-fable-5.1_proposal.md), [Sol-П §4](../consensus/round-2/codex-gpt-6.1-sol_proposal.md).
- Ресёрч: [browser-automation §5](../01-research/browser-automation.md); [data-sources §2](../01-research/data-sources-and-licenses.md); [prior-art §3 (autoconsent, Consent-O-Matic)](../01-research/prior-art.md).
