# Прототип dsgvo-check — бриф для реализации

Минимальный рабочий прототип по утверждённым контрактам: проверка архитектуры на живых сайтах, не релиз 1.0. Он честно сканирует сайт, выдаёт отчёты в JSON, консоли и HTML, возвращает коды выхода и покрыт тестами. Канареечный прогон по локальному корпусу измеряет сканер (доля `inconclusive`, бот- и гео-режим, ошибки сбора), а не служит критерием приёмки.

Контракты — в [архитектуре](../02-architecture.md) и [спецификации проверок](../03-checks.md); всё, что не названо упрощением, следует им. Имена вариантов и `messageId` задаёт `test/data/ruleset/de-2026/*.yaml`: таблицу [`docs/03-checks.md`](../03-checks.md) §2.1 генерирует `corepack pnpm registry`, расхождение ловит L0-тест `test/unit/core/registry-completeness.test.ts`.

## Проверки

14 из 15 P0 (без PRIV-02) и CONSENT-05:

- browser: CONSENT-01…05, TRACK-01, EMBED-01, EMBED-02, LEGAL-01, PRIV-01;
- http/tls: HDR-01, TLS-01, TLS-02;
- dns: MAIL-01, MAIL-02.

Диагностики — все `SCAN-*` из [03-checks, раздел 7](../03-checks.md): `BOTMODE`, `GEO`, `UNREACHABLE`, `BLOCKED`, `TIMEOUT`, `SANDBOX-OFF`, `THROTTLED`, `PRIVATE-REQUEST-BLOCKED` (SSRF-граница).

## Фазы браузера

Каждая фаза идёт в свежем `launchPersistentContext(tmpdir)`.

- **A** — до 6 страниц, без взаимодействия.
- **B** — стартовая: наблюдение ≥ 4 с до клика, снимок первого экрана, «Ablehnen», проверка отказа, reload, затем до 2 контрольных страниц.
- **C** — «Alle akzeptieren» на стартовой и те же контрольные страницы; нужна для инвентаря PRIV-01. Пропускается, если в B не распознан CMP.

## CMP-адаптеры

Borlabs, Cookiebot, Complianz, Usercentrics, CCM19, Real Cookie Banner, CookieHub. Контракт — `extract / act / verify`, без решений; подробности — в [архитектуре, раздел 8](../02-architecture.md).

- Что считать отказом и согласием и куда кликать, решает чистая `classifyFirstLayer(facts, lexicon)` в core. Выбор пишется в `plan.click` и передаётся адаптеру как `ActOptions.target`; адаптер кликает ровно по нему.
- Default-denied без ответа пользователя отказом не считается. Распознавание `high` требует ≥ 2 независимых признаков.
- Баннер не распознан → CONSENT-04 `info` «Banner nicht erkannt», статус `inconclusive`.

## Отчёты

- **JSON** — контракт: zod 4 → JSON Schema 2020-12 в `schema/report.schema.json` (пишет `corepack pnpm build`, в git не хранится), проверка Ajv в тестах.
- **Консоль.**
- **HTML** — один файл без JS и внешних ресурсов, с CSP в meta-теге: `default-src 'none'; img-src data:; style-src 'sha256-…'; base-uri 'none'; form-action 'none'`. Скриншот баннера встроен как `data:`.
- **GitHub Job Summary** — Markdown.
- **PDF** — печать того же HTML по явному `--format pdf` или `html,pdf`. Сбой печати — одна строка предупреждения, код выхода и JSON не меняются.

## CLI

```
dsgvo-check [url]                   (url не нужен при --from-snapshot)
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
  --verbose                         (подробные логи в stderr)
dsgvo-check install [--with-deps]   (скачивает Chromium для playwright-core; --with-deps — системные библиотеки Linux, нужен root)
dsgvo-check report <report.json> --format html,pdf [--lang de|en] [--out dir]
```

- Коды выхода и приоритет — по таблице раздела 12 [архитектуры](../02-architecture.md). `gate()` — чистая функция с табличными тестами. `--strict` действует и при `--fail-on none`.
- `--help` заканчивается «Nutzungshinweise» ([wording guide §6](../legal/wording-guide.md)); тот же текст — в `README.md`.

## Обязательные контракты

- `--sandbox require` ⇒ `chromiumSandbox: true` и запуск без `--no-sandbox`. Не поднялась — exit 2.
- User-Agent браузера — `navigator.userAgent` запущенного Chrome for Testing (`HeadlessChrome/` → `Chrome/`) плюс честный токен сканера со ссылкой на репозиторий, а не `browser.version()`.
- Снимок первого экрана — `page.screenshot({ clip })` по `box` контейнера баннера, без автопрокрутки и до любого действия; `locator.screenshot()` не используется. Только при однозначном контейнере ≤ 50 % viewport, иначе `screenshot-skipped`.
- TLS-02 — пороги срока относительно срока действия L ([спецификация, §3.14](../03-checks.md)). Для IP-цели `X509Certificate.checkIP`, для имени `checkHost`.
- Поля `request` в alpha-схеме: `delivery`, `result`, `provenance`, монотонный `tMs` от `scan.startedAt`, `navigationId`, `actionId`, `frameId`, `parentRequestId` и безопасные `features` (`identifier {kind, param}`, `matchesStoredIdentifier`, `eventType`, `consentSignal`, `parserVersion`, `observationSource`).
- CONSENT-01 и CONSENT-05 — по устойчивому идентификатору и подтверждённому отказу (`origin: action`, затем `stored` после reload). Документы собираются независимо от отказа.

## Доставка

- `Dockerfile`: `node:24-bookworm-slim`, Chromium из playwright-core, non-root, tini; `.dockerignore`.
- `action.yml`: composite → `docker run` образа по тегу версии из `package.json`. GitLab-шаблон `templates/gitlab/dsgvo-check.gitlab-ci.yml` — так же.
- `.github/workflows/ci.yml` — CI самого проекта.

## Канарейка

Подробности — в [canary/README.md](../../canary/README.md).

- `canary/sites.yaml` — локальный корпус пользователя, в git не попадает. Пример — `canary/sites.example.yaml` с вымышленными хостами.
- Раннер `scripts/canary.ts`, сводка — `node scripts/canary.ts summary`. Результаты в `canary/results/` в git не попадают.
- Это разовое измерение (классы действий O и T), а не приёмка. Приёмочную канарейку (10 сайтов с письменным согласием владельцев, `mustFind` / `mustNotFind`) оно не заменяет. Разовый замер подтверждён заказчиком; условия приёмочной остаются отдельными.

## Упрощения прототипа

- Нет фаз A′ и M, in-process egress-прокси и `EgressPolicy` (этап 2).
- **SSRF-граница** вместо `EgressPolicy`:
  - проверка IP в preflight и в инжектируемом `lookup`; хост с хотя бы одним непубличным адресом отклоняется сразу (`target-mixed-addresses`);
  - в браузере — блокировка private/loopback/link-local/metadata-адресов и неразрешимых имён (fail-closed) для **документов верхнего уровня, фреймов и popup** через CDP `Fetch` (не `page.route`: он не видит редиректные хопы);
  - подресурсы и DNS rebinding не покрыты;
  - в тестах хосты подменяются через `--host-resolver-rules` и `connect.lookup` у undici.
- PRIV-01 смотрит только видимый и раскрываемый текст DSE на той же странице и во фреймах. PDF → `inconclusive`. Отрицания не разбираются, поэтому уверенность не выше `medium`.
- Нет PRIV-02, P1 (кроме CONSENT-05) и P2. Нет JUnit, baseline и suppressions: поля в схеме есть, логики нет.
- autoconsent не используется; неизвестные CMP распознаются общей эвристикой, только `info`.
- Тексты `de` и `en` — черновики с `draft: true`, штамп «Textentwurf».

## Стек

Версии — в `package.json`: пин без `^` (`.npmrc`: `save-exact=true`), правила для зависимостей — в [AGENTS.md](../../AGENTS.md).

- Node ≥ 24 (`.node-version`: 24), TypeScript 7 (нативный `tsc` → `dist/`).
- pnpm — через `corepack pnpm` (`packageManager` в `package.json`); глобальный pnpm не нужен, первый запуск — с `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`.
- Только для тестов: `dns2` (фейковый DNS в L2), `@peculiar/x509` (тестовые сертификаты; требует `reflect-metadata`), `ajv` с `ajv-formats` (валидация схемы отчёта).
