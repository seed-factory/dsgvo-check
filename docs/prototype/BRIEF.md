# Прототип dsgvo-check — бриф для реализации

Минимальный рабочий прототип по утверждённым контрактам. Это не релиз 1.0, а проверка архитектуры на живых сайтах. Он должен честно сканировать сайт и выдавать JSON, консольный и HTML-отчёт с кодами возврата. Покрыт тестами. Канареечный прогон по локальному корпусу — измерение сканера (доля `inconclusive`, бот- и гео-режим, ошибки сбора), а не критерий приёмки.

Источники контрактов — [архитектура](../02-architecture.md) и [спецификация проверок](../03-checks.md). Прототип им следует. Если решение для прототипа упрощено, это записано ниже в разделе «Упрощения». Всё остальное следует этим документам. Имена вариантов и `messageId` — по реестру [`docs/03-checks.md`](../03-checks.md) §2.1; его сверяет L0-тест `test/unit/core/registry-spec.test.ts`.

## Объём

**Проверки** (уровни, варианты и понижения — по [спецификации проверок](../03-checks.md)):

| Модуль | Проверки |
|---|---|
| browser | CONSENT-01, CONSENT-02, CONSENT-03, CONSENT-04, CONSENT-05, TRACK-01, EMBED-01, EMBED-02, LEGAL-01, PRIV-01 |
| http/tls | HDR-01, TLS-01, TLS-02 |
| dns | MAIL-01, MAIL-02 |

**Диагностики:** `SCAN-BOTMODE`, `SCAN-GEO`, `SCAN-UNREACHABLE`, `SCAN-BLOCKED`, `SCAN-TIMEOUT`, `SCAN-SANDBOX-OFF`; дополнительно `SCAN-THROTTLED` и `SCAN-PRIVATE-REQUEST-BLOCKED` (SSRF-граница).

**Фазы браузера:**
- **A** — до 6 страниц, без взаимодействия.
- **B** — стартовая: наблюдение ≥ 4 с до клика, снимок первого экрана, «Ablehnen», проверка отказа, reload, затем до 2 контрольных страниц.
- **C** — «Alle akzeptieren» на стартовой, нужна для инвентаря PRIV-01.

Каждая фаза запускается в свежем `launchPersistentContext(tmpdir)`.

**CMP-адаптеры:** Borlabs, Cookiebot, Complianz, Usercentrics, CCM19, Real Cookie Banner, CookieHub. Контракт адаптера — `extract / act / verify`, без решений. `extract(page) → CmpFacts` (распознавание, кнопки с ролью и геометрией, блокировка, `ConsentState`, гео- и бот-сигналы); `act(page, action, target)` — клик ровно по элементу, который выбрала core; `verify(page)` — состояние сразу после действия и после reload. Что считать отказом и согласием, блокирует ли баннер и куда кликать, решает только чистая `classifyFirstLayer(facts, lexicon)` в core; выбор пишется в `plan.click`, и коллектор передаёт адаптеру именно эту цель (`ActOptions.target` для `reject`/`accept`). Default-denied без ответа пользователя отказом не считается. Распознавание с уверенностью `high` требует ≥ 2 независимых признаков. Если баннер не распознан, CONSENT-04 даёт `info` «Banner nicht erkannt» и статус `inconclusive`.

**Отчёты:**
- **JSON** — контракт; zod 4 → JSON Schema 2020-12 в `schema/report.schema.json`, проверка Ajv в тестах.
- **Консоль.**
- **HTML** — один файл, без JS, без внешних ресурсов, с полной CSP: `default-src 'none'; img-src data:; style-src 'sha256-…'; base-uri 'none'; form-action 'none'` в meta-теге; скриншот баннера встроен как `data:`.
- **GitHub Job Summary** — Markdown.
- **PDF** — печать того же HTML по явному `--format pdf` или `--format html,pdf`. По умолчанию выключен; сбой печати даёт одну строку предупреждения без файла, не меняя код выхода и JSON.


**CLI:**

```
dsgvo-check <url>
  --fail-on critical|warning|none   (default: critical)
  --format console,json,html,pdf,summary  (default: console,json)
  --out <dir>                       (default: ./dsgvo-check-report)
  --max-pages <n>                   (default: 6)
  --timeout <duration>              (default: 8m)
  --proxy <url>                     (только http:// — HTTP CONNECT; SOCKS5 — бэклог)
  --assume-region eea|de
  --lang de|en                      (default: de)
  --strict
  --sandbox require|off             (default: require)
  --no-screenshots
  --save-snapshot <file>
  --from-snapshot <file>
  --checks <ID,...>
dsgvo-check install                 (скачивает Chromium для playwright-core)
dsgvo-check report <report.json> --format html,pdf [--lang de|en] [--out dir]
```

Коды возврата и приоритет — по таблице раздела 12 [архитектуры](../02-architecture.md). Функция `gate()` чистая и покрыта таблично-управляемыми тестами. `--strict` действует и при `--fail-on none`.

`--help` заканчивается «Nutzungshinweise» (wording guide §6): только свои или порученные сайты, отчёты о чужих сайтах не для публикации, токен User-Agent, фаза C раскрывает IP сканера, DNS при `--proxy` идёт напрямую к резолверу. Тот же текст — в `README.md`.

**Обязательные контракты прототипа**:
- `--sandbox require` ⇒ `chromiumSandbox: true` и запуск без `--no-sandbox`; не поднялась — exit 2.
- User-Agent браузера — `navigator.userAgent` запущенного Chrome for Testing (`HeadlessChrome/` → `Chrome/`) плюс честный токен сканера со ссылкой на репозиторий, а не `browser.version()`.
- Снимок первого экрана — `page.screenshot({ clip })` по `box` контейнера баннера, без автопрокрутки и до любого действия; `locator.screenshot()` не используется. Только при однозначном контейнере ≤ 50 % viewport, иначе `screenshot-skipped`.
- TLS-02 — пороги относительно срока действия L (`< min(14 д, 25 % L)` → `warning`, `< min(30 д, 50 % L)` → `info`, при L ≤ 10 д находки о сроке нет); для IP-цели — `X509Certificate.checkIP`, для имени — `checkHost`.
- Поля `request` в alpha-схеме: `delivery`, `result`, `provenance`, монотонный `tMs` от `scan.startedAt`, `navigationId`, `actionId`, `frameId`, `parentRequestId` и безопасные `features` (`identifier {kind, param}`, `matchesStoredIdentifier`, `eventType`, `consentSignal`, `parserVersion`, `observationSource`).
- CONSENT-01 и CONSENT-05 — по устойчивому идентификатору и подтверждённому отказу (`origin: action`, затем `stored` после reload); документы собираются независимо от отказа.

**Доставка:**
- `Dockerfile`: `node:24-bookworm-slim`, Chromium из playwright-core, non-root, tini; `.dockerignore`.
- `action.yml`: composite → `docker run` образа по тегу версии из `package.json`; GitLab-шаблон — так же.
- `templates/gitlab/dsgvo-check.gitlab-ci.yml`.
- `.github/workflows/ci.yml` — CI самого проекта.

**Канарейка:**
- `canary/sites.yaml` — локальный корпус пользователя, исключённый из git. Пример со всеми полями схемы — `canary/sites.example.yaml` с вымышленными хостами; фиксированный размер проверяется только по `--expected-count <n>`.
- Раннер `scripts/canary.ts` — низкая параллельность, вежливые паузы, сохранение снимков.
- Сводка `scripts/canary-summary.ts`.
- Результаты лежат в `canary/results/` и в git не попадают.
- Это разовое измерение сканера (классы O и T, вежливые паузы), а не приёмка: приёмочную канарейку (10 сайтов с письменным согласием владельцев, `mustFind` / `mustNotFind`) она не заменяет. Разовый замер подтверждён заказчиком; условия приёмочной канарейки остаются отдельными.


## Упрощения прототипа

Отличия от релизных контрактов:

- Нет фаз A′ и M, нет in-process egress-прокси и `EgressPolicy` (этап 2). SSRF-граница — проверка IP в preflight и в инжектируемом `lookup`, а в браузере — блокировка private/loopback/link-local/metadata-адресов и неразрешимых имён (fail-closed) для **документов верхнего уровня, фреймов и popup** через CDP `Fetch` на уровне браузера (не `page.route`: он не видит редиректные хопы). Подресурсы и DNS rebinding не покрыты. Хост с хотя бы одним непубличным адресом отклоняется уже в preflight (`target-mixed-addresses`). В тестах хосты подменяются через `--host-resolver-rules` и `connect.lookup` у undici.
- PRIV-01 работает только по видимому и раскрываемому тексту DSE на той же странице и фреймам. PDF → `inconclusive`. Отрицания не разбираются, поэтому уверенность не выше `medium`.
- Нет PRIV-02, P1 (кроме CONSENT-05) и P2. Нет JUnit, baseline и suppressions: поля в схеме есть, логики нет.
- autoconsent не используется. Распознавание неизвестных CMP — общая эвристика, только `info`.
- Тексты `de` и `en` — черновики с `draft: true`, штамп «Textentwurf».

## Стек и версии

Версии сверены с npm-реестром 2026-10-30. Пинить точно, без `^`.

| Пакет | Версия | Назначение |
|---|---|---|
| Node | ≥ 24 (`.node-version`: 24) | рантайм; TS запускается через `tsc` → `dist/` |
| pnpm | 12.16.1 через `corepack pnpm` (`packageManager: "pnpm@12.16.1"` в `package.json`; глобальный pnpm не нужен, первый запуск — с `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`) | пакетный менеджер |
| typescript | 7.0.2 | `tsc` (нативный) |
| playwright-core | 1.64.1 | браузер |
| undici | 8.12.3 | HTTP |
| tldts | 7.4.19 | eTLD+1 |
| zod | 4.6.7 | схема отчёта |
| yaml | 2.9.1 | данные |
| commander | 15.0.0 | CLI |
| canonicalize | 5.1.0 | JCS для fingerprint |
| vitest | 5.0.5 | тесты |
| @biomejs/biome | 2.6.4 | линт и формат |
| ajv / ajv-formats | 8.20.0 / 3.0.1 | валидация схемы в тестах |
| dns2 | 3.1.1 | фейковый DNS в L2 |
| @peculiar/x509 | 3.1.0 | тестовые сертификаты |
| @types/node | 24.19.2 | типы |

Требования к зависимостям и изменениям описаны в [AGENTS.md](../../AGENTS.md).
