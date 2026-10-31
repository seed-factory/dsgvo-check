# Ревью прототипа — что исправлено

Дата: 2026-10-30. Исходные находки и голоса — [CONSENSUS.md](CONSENSUS.md). Исправления делали шесть зональных агентов (core, browser-collector, cmp, checks-derive, net-dns, delivery) и интегратор. Каждая находка сначала воспроизведена тестом, который падал на старом коде, затем исправлена. Режим `verify` (находки `unsure` и пропущенные обоими) чинился только после собственного подтверждения.

Итог: 90 строк (83 находки моделей и 7 пропущенных обоими). Исправлено 82, не воспроизведено 1 (FP-09), отклонено консенсусом 7. Отложенных (`deferred`) нет; открытые вопросы к владельцам спецификации — в конце.

Пути тестов даны от корня репозитория. «L2» — `test/integration/**`, «L3» — `test/e2e/**`, остальное — L0/L1 (`test/unit/**`).

## Принятые находки

| ID | Результат | Тест | Что изменено |
|---|---|---|---|
| S-01 | fixed | `test/integration/browser/ssrf.test.ts`, `test/integration/browser/pure/review-fixes.test.ts` | Браузерный guard fail-closed: неразрешимое имя (`unresolved`) блокируется, как в `fetchText`. |
| S-03 | fixed | `test/unit/checks/http/collector-client.test.ts`, `test/integration/http/http-collector.test.ts` | `decodeBody` ограничивает распакованный размер (gzip/deflate/br-бомба → усечение, `truncated`). |
| S-04 | fixed | `test/unit/core/url-net.test.ts`, `test/unit/core/scan.test.ts` | `redactTarget`/`redactTargetInfo`: снимок, отчёт и failed-отчёт хранят очищенный target; сырой URL — только в `ctx.target` коллекторов. |
| S-05 | fixed | `test/unit/checks/dns/collector.test.ts` | Маскирование `mailto:` по склеенной записи TXT, а не по отдельным строкам. |
| S-06 | fixed | `test/integration/browser/pure/review-fixes.test.ts` | `setterUrl` attempted-cookie проходит `sanitizeRequestUrl` (одна точка `cleanSetter`). |
| S-07 | fixed | `test/integration/browser/pure/review-fixes.test.ts`, `test/unit/checks/http/collector-client.test.ts` | Заголовки ответа: URL-заголовки очищаются, значения — только по allowlist; общий нормализатор `src/core/headers.ts` (см. FP-08). |
| S-08 | fixed | `test/unit/core/url-net.test.ts` | `sanitizeUrl` маскирует `mailto:` до домена; это покрывает и ссылки CMP. |
| S-09 | fixed | `test/unit/core/gate.test.ts`, `test/unit/core/scan.test.ts` | `--strict` действует при `--fail-on none`; табличный тест №19 исправлен. |
| S-10 | fixed | `test/unit/core/scan.test.ts`, `test/unit/core/gate.test.ts` | Глобальный timeout до завершения стартовой фазы A → `failed`, `SCAN-TIMEOUT`, fatal `timeout`, код 2. |
| S-11 | fixed | `test/unit/core/scan.test.ts` | После abort оркестратор ждёт результат коллектора до `ABORT_GRACE_MS` (10 с); собранные факты сохраняются. |
| S-12 | fixed | `test/unit/derive/derive.test.ts`, `test/unit/checks/browser/consent-01.test.ts` | Идентификатор — только из фактов коллектора до редактирования; ключ в очищенном URL доказательством не считается. |
| S-13 | fixed | `test/unit/checks/browser/consent-01.test.ts`, `consent-03.test.ts`, `consent-05.test.ts` | Совпадение с сохранённым идентификатором даёт `tracking-completed` и при Consent Mode `denied`. |
| S-14 | fixed | `test/unit/cmp/detection.test.ts`, `test/integration/cmp/usercentrics.test.ts` | Default-denied без ответа пользователя — не отказ; `origin: action` только для ответа, который дал клик. |
| S-15 | fixed | `test/unit/checks/browser/consent-05.test.ts` | Отказ подтверждён только при `origin: action` и `stored` после reload (`persistedAfterReload === true`). |
| S-16 | fixed | `test/integration/browser/pure/review-fixes.test.ts` | Повторная запись cookie/storage после клика даёт отдельную запись `afterClick`. |
| S-17 | fixed | `test/unit/derive/derive.test.ts`, `test/unit/checks/browser/consent-01.test.ts`, `track-01.test.ts`, `test/integration/browser/pure/recorder.test.ts` | derive опирается на `delivery: sent` и статус ответа; recorder больше не затирает `result: response` ошибкой тела (интегратор, корневая причина). |
| S-18 | fixed | `test/unit/checks/http/tls-01.test.ts` | TLS-01 оценивает конец цепочки: http → https → http с формой даёт `form-on-http-page`. |
| S-19 | fixed | `test/unit/checks/http/tls-02.test.ts`, `test/integration/http/http-collector.test.ts` | HTTP-коллектор пишет TLS финального хоста после междоменного редиректа в `http.finalTls`; TLS-02 `requires: ['tls','http']`. |
| S-20 | fixed | `test/integration/http/http-collector.test.ts`, `test/integration/http/tls-collector.test.ts`, `test/unit/core/scan.test.ts` | Явный порт цели сохраняется в HTTP- и TLS-коллекторе; `tlsBlocked` ищет endpoint цели на любом порту (интегратор). |
| S-21 | fixed | `test/unit/core/url-net.test.ts`, `test/unit/core/scan.test.ts` | `bareHost` снимает скобки IPv6-литерала для DNS и проверки адреса. |
| S-22 | fixed | `test/unit/checks/dns/dmarc.test.ts`, `mail-01.test.ts` | SERVFAIL на шаге обхода DMARC → ошибка проверки, политика родителя её не подменяет. |
| S-23 | fixed | `test/unit/checks/dns/mail-02.test.ts` | SERVFAIL внутри SPF include → `error` MAIL-02. |
| S-24 | fixed | `test/unit/checks/browser/legal-01.test.ts`, `priv-01.test.ts` | `usableDocument`: soft-404 и `keyword-missing` не считаются найденным документом. |
| S-25 | fixed | `test/integration/browser/pure/review-fixes.test.ts` | Происхождение частей фрейма сохраняется (`hidden-irrelevant` не становится `frame`). |
| S-26 | fixed | `test/integration/browser/pure/review-fixes.test.ts` | Усечение, нераскрытые части и ошибки фреймов снижают `complete` и пишутся в manifest. |
| S-27 | fixed | `test/integration/browser/throttle.test.ts`, `test/unit/checks/browser/throttle-and-guards.test.ts` | Политика 429/503 для всех навигаций (Retry-After, один повтор, остановка); проверки при throttled-фазе — `partial`/`inconclusive` (интегратор). |
| S-28 | fixed | `test/integration/http/http-collector.test.ts` | Счётчик 429/503 и пауза Retry-After — на хост. |
| S-29 | fixed | `test/unit/core/assess.test.ts`, `gate.test.ts` | `maxSeverity` без кэпа confidence. |
| S-30 | fixed | `test/unit/checks/browser/request-evidence.test.ts`, `test/integration/browser/pure/recorder.test.ts`, `test/integration/browser/consent.test.ts`, `test/unit/core/scan.test.ts` | Интегратор: `request` evidence по 5.3 — `delivery`, `result` (вкл. `aborted`), `provenance`, `tMs` на одной монотонной шкале от `scan.startedAt` (`ctx.clock`), `navigationId`, `actionId`, `frameId`, `parentRequestId`, `features {identifier {kind, param}, matchesStoredIdentifier, eventType, consentSignal, parserVersion, observationSource}`; cookie/storage — тот же `tMs` и id; `SCHEMA_VERSION` 0.2.0. Проверки читают прежние поля записей, совместимость сохранена. |
| S-31 | fixed | `test/integration/browser/pure/integration-fixes.test.ts`, `test/unit/cmp/*` | Адаптер исполняет цель core (`act(page, action, target)`); мост коллектора передаёт `plan.click` target вместо facts (интегратор). |
| S-32 | fixed | `test/unit/checks/browser/variant-registry.test.ts`, `test/unit/core/registry-spec.test.ts` | Имена вариантов и `messageId` всех проверок приведены к реестру 03-checks §2.1. |
| S-34 | fixed | `test/unit/checks/http/collector-html.test.ts` | `detectForm` игнорирует `<script>`, `<template>` и строки JS. |
| S-35 | fixed | `test/integration/browser/pure/review-fixes.test.ts` | Повторный `close` ждёт уже начатую очистку профиля. |
| S-36 | fixed | `test/unit/checks/dns/spf.test.ts` | `ip6:` проверяется `net.isIP`. |
| S-37 | fixed | `test/unit/checks/http/tls-01.test.ts`, `tls-02.test.ts` | Интегратор: subject `http-entry:<role>` / `certificate:<role>` через `tlsHostRole` относительно финального хоста; отпечаток не зависит от ввода www/apex. |
| S-39 | fixed | `test/integration/browser/fatal.test.ts` | Тест отмены проверяет, что сбор начался, и что процессы и профили убраны. |
| FC-01 | fixed | `test/unit/core/gate.test.ts` | То же, что S-09. |
| FC-02 | fixed | `test/integration/browser/attribution.test.ts`, `test/unit/core/report-coverage.test.ts` | Коллектор атрибутирует страницу по `finalUrl`; coverage сопоставляет план и визит по запрошенному или финальному URL — одна строка на стартовую (интегратор). |
| FC-03 | fixed | `test/integration/browser/attribution.test.ts` | Момент клика — первое доверенное нажатие в странице (`clickedAtSource: input-event`), запросы до него остаются до клика. |
| FC-04 | fixed | `test/unit/cmp/lexicon.test.ts`, `classify.test.ts` | «Ablehnen und schließen» классифицируется как reject (приоритет reject при равном счёте с close). |
| FC-05 | fixed | `test/unit/core/scan.test.ts` | То же, что S-10. |
| FC-06 | fixed | `test/integration/browser/throttle.test.ts`, `test/unit/checks/browser/throttle-and-guards.test.ts` | 429 на стартовой после повтора — `SCAN-THROTTLED`, не fatal; проверки без оцениваемой страницы A — `inconclusive (throttled)` (интегратор). |
| FC-07 | fixed | `test/unit/checks/browser/embed-01.test.ts` | EMBED-01 узнаёт пробел `preconnect-without-request` по префиксу. |
| FC-08 | fixed | `test/unit/derive/derive.test.ts`, `test/unit/checks/browser/consent-01.test.ts`, `consent-05.test.ts` | `identifier.kind` (stored-match / persistent-param / user-supplied / per-load / none); per-load не даёт critical. |
| FC-09 | fixed | `test/integration/browser/pure/review-fixes.test.ts`, `attribution.test.ts` | `combineVerify`: отказ, подтверждённый только после reload, считается подтверждённым. |
| FC-10 | fixed | `test/integration/browser/pure/review-fixes.test.ts` | Закрытие браузера и удаление профиля при abort ожидаются; оставшиеся профили чистятся. |
| FP-01 | fixed | `test/integration/browser/ssrf.test.ts` | Guard — сессия CDP `Fetch` на уровне браузера: popup и вложенные cross-site OOPIF покрыты, popup-blocker включён. |
| FP-02 | fixed | `test/integration/browser/pure/review-fixes.test.ts` | То же, что S-01. |
| FP-04 | fixed | `test/unit/core/url-net.test.ts` | NAT64, 6to4, Teredo распаковываются в IPv4; `fec0::/10` — private. |
| FP-05 | fixed | `test/unit/core/scan.test.ts`, `test/integration/browser/ssrf.test.ts` | Хост со смешанными адресами отклоняется в preflight (`target-mixed-addresses`); сообщение `start-page-not-public` говорит о редиректе, только если заблокирован другой хост (интегратор). |
| FP-06 | fixed | `test/unit/core/url-net.test.ts`, `test/integration/browser/pure/features.test.ts` | `QUERY_VALUE_RULES` для `id`/`tid`/`v`/`t`; `eventType` только из `en`/`ev` или `t` как тип хита UA (интегратор). |
| FP-07 | fixed | `test/integration/browser/pure/review-fixes.test.ts` | То же, что S-06. |
| FP-08 | fixed | `test/integration/browser/pure/review-fixes.test.ts`, `test/unit/checks/http/collector-client.test.ts` | Один нормализатор заголовков `src/core/headers.ts` для HTTP и браузера: значения только у заголовков безопасности и технических, URL очищены, прочее `[redacted]` (интегратор). |
| FP-10 | fixed | `test/unit/checks/browser/wording.test.ts`, `test/unit/core/stopwords.test.ts` | Тексты EMBED и другие без «vor einer Einwilligung» и меток «Tracking-…»; L0 правил 2, 3, 6, 10, 13 для всех модулей и отрендеренных отчётов (интегратор), legalNote CONSENT-02 переписан. |
| FP-11 | fixed | `test/unit/reporters/disclaimer.test.ts`, `test/unit/core/scan.test.ts`, `test/integration/core/cli.test.ts` | Дисклеймер с условными абзацами (в т. ч. фаза C); композиция перенесена в core и применяется к отчёту в памяти и к failed-отчёту CLI; «Nutzungshinweise» в `--help` и `README.md` (интегратор). |
| FP-12 | fixed | `test/e2e/delivery-config.e2e.test.ts` | Action и GitLab-шаблон по умолчанию — образ по digest. |
| FP-13 | fixed | `test/e2e/traffic-docs.e2e.test.ts` | Правило 1 канарейки описывает только реальные пробы (без `security.txt`); добавлены хендшейки финального хоста и цепочка явного порта (интегратор). |
| FT-01 | fixed | `test/unit/core/gate.test.ts` | То же, что S-09. |
| FT-02 | fixed | `test/integration/core/cli.test.ts` | L2 CLI идёт через офлайн-резолвер (`offline-network-hook.ts`); шаг CI «Packed CLI» больше не делает DNS-запрос (интегратор). |
| FT-03 | fixed | `test/unit/checks/browser/consent-05.test.ts` | Контрпример attempted/rejected cookie после отказа. |
| FT-04 | fixed | `test/unit/checks/browser/consent-02.test.ts` | Запись в B до клика — находка. |
| FT-05 | fixed | `test/unit/checks/browser/consent-04.test.ts` | Отрицательные контроли для неготового verify и согласия после собственного действия. |
| FT-06 | fixed | `test/unit/checks/browser/consent-03.test.ts` | Ветка `--assume-region` и контрпримеры cookieless. |
| FT-07 | fixed | `test/unit/checks/browser/consent-01.test.ts` | Известный CDN → `third-party-resource`; репликация без B. |
| FT-08 | fixed | `test/unit/checks/http/tls-02.test.ts`, `test/unit/core/registry-completeness.test.ts` | `not-yet-valid` покрыт; список вариантов без фикстуры зафиксирован и может только сокращаться (интегратор). |
| FT-09 | fixed | `test/unit/core/registry-spec.test.ts` | Интегратор: L0 парсит таблицу 03-checks §2.1 и сверяет варианты, уровни и `locked` с ruleset, объявлениями проверок, текстами de/en и crm для 15 проверок прототипа; исключений нет. |
| FT-10 | fixed | `test/unit/core/scan.test.ts`, `gate.test.ts` | То же, что S-10 (`FatalReason` `timeout`). |
| FT-11 | fixed | `test/e2e/delivery-config.e2e.test.ts` | CI ставит `DSGVO_CHECK_TEST_SANDBOX=require` для L2. |
| FT-12 | fixed | `test/e2e/docker.e2e.test.ts` | Образ и шаг Action проверены на кодах 0, 1 и 2. |
| FT-13 | fixed | `test/unit/checks/browser/track-01.test.ts` | Контрпример `blocked-by-browser`. |
| FT-17 | fixed | `test/e2e/delivery-config.e2e.test.ts` | Пример workflow закреплён на SHA собственного Action. |
| FT-18 | fixed | `test/unit/core/scan.test.ts` | Тест `report-write-failed` вызывает ошибку репортёра детерминированно и проверяет перезапись JSON. |
| FT-19 | fixed | `test/unit/checks/http/hdr-01.test.ts`, `tls-01.test.ts`, `test/unit/checks/dns/mail-01.test.ts`, `test/unit/checks/browser/throttle-and-guards.test.ts` | Контрпримеры к выжившим мутациям: HTTP/DNS — зона net-dns, браузерные условия (hasPhaseA, CONSENT-02 attempted/sent, EMBED-01 rel и after-accept, EMBED-02 контакт, LEGAL-01 reload, PRIV-01 без стадий) — интегратор. |
| FT-20 | fixed | `test/e2e/delivery-config.e2e.test.ts`, `test/e2e/docker.e2e.test.ts` | Метка версии образа берётся из `package.json` (`--build-arg VERSION`). |

## Находки на проверку (`verify`)

| ID | Результат | Тест | Что изменено или почему нет |
|---|---|---|---|
| S-33 | fixed | `test/unit/checks/browser/consent-05.test.ts` | Подтверждено: без перехвата pagehide CONSENT-05 — `inconclusive` (`pagehide-capture-unavailable`); установленные находки сохраняются. Расхождение с §2.1 — открытый вопрос 1 ниже. |
| FP-09 | not-reproduced | — | Зона browser-collector не воспроизвела: ошибки навигации (`goto`, `reload`) перехватываются в `visit.ts` и сохраняются только кодом (`navigation-failed:<ERR_…>`); оставшиеся сообщения (`phase-failed`, `document-extract-failed`, `cmp-*-failed`, скриншот) приходят из `evaluate`, локаторов и CDP и URL навигации не содержат. Остаточный риск записан в STATUS §5. |
| SM-01 | fixed | `test/unit/core/scan.test.ts`, `test/integration/core/cli.test.ts` | Как S-04, включая failed-путь CLI и `scan()`. |
| SM-02 | fixed | `test/integration/browser/pure/review-fixes.test.ts` | Как S-16. |
| SM-03 | fixed | `test/unit/core/scan.test.ts` | Как S-11. |
| SM-04 | fixed | `test/integration/browser/throttle.test.ts` | Как S-27. |
| SM-05 | fixed | `test/unit/checks/browser/request-evidence.test.ts`, `test/integration/browser/pure/recorder.test.ts` | Подтверждено интегратором: тест evidence падал на старом коде (`delivery`/`result`/`features` отсутствовали, `tStartMs` сбрасывался по навигации и клику). Исправлено вместе с S-30. |
| SM-06 | fixed | `test/integration/http/http-collector.test.ts`, `test/unit/checks/http/tls-02.test.ts` | Как S-19. |
| SM-07 | fixed | `test/unit/checks/http/tls-01.test.ts` | Как S-18. |

## Отклонённые находки

Причины — голос второй модели в [CONSENSUS.md](CONSENSUS.md) (столбец «Обоснование голоса»); код не менялся.

| ID | Причина |
|---|---|
| S-02 | Вложенные cross-site OOPIF — сознательное упрощение, названное в ssrf.ts и STATUS. Позже закрыто попутно: guard стал браузерной сессией CDP (FP-01). |
| S-38 | BRIEF требует фикстуры на ID, а не на вариант; тест полноты это проверяет. Видимость пробелов добавлена без смены правила (FT-08). |
| FP-03 | Проверка адреса назначения за `--proxy` — часть `EgressPolicy` (5.7), перенесённой за ворота прототипа (консенсус §2а). |
| FP-14 | 5.3 предусматривает сведения о резолвере, 5.7 требует прозрачности DNS-маршрута; запрета хранить адреса резолверов нет. |
| FT-14 | Строгое сравнение в `assess.ts:282` верно, дедупликация и усечение уже проверены; дефект есть только в мутированном коде. |
| FT-15 | Сортировка `check-error:*` и условие `timeout` в `gate.ts` верны; регрессия не воспроизводится. |
| FT-16 | Vitest исполняет изолированные файлы integration последовательной группой; одновременного запуска с unit нет. |

## Cross-zone изменения интегратора

Сделаны по отчётам зон, помимо строк выше:

- `test/integration/browser/sites.test.ts` — ожидание `id=[redacted]` после FP-06 (уже было исправлено зоной).
- `test/integration/pipeline/consent-flow.test.ts` — пять переименований вариантов по §2.1.
- `data/texts/{de,en}/core.yaml` — `SCAN-PRIVATE-REQUEST-BLOCKED` использует `{count}` и `{addressClass}`, `SCAN-THROTTLED` — текст §7.5; тест `test/unit/core/messages.test.ts`.
- `AGENTS.md` — форматирование таблицы (biome).
- `docs/prototype/{CONTRACTS,STATUS,BRIEF}.md` — контракты после ревью, статус, поправки 4б.
- Наблюдение delivery о `--from-snapshot` на фикстуре CONSENT-01 (`cookieless-ping` вместо `tracking-completed`) не воспроизводится после S-13: CLI даёт `tracking-completed` (critical).
- FC-03 не потребовал `ClickOutcome.clickedAt` в `src/cmp/types.ts`: момент клика берётся из доверенного нажатия в странице.

## Открытые вопросы к владельцам спецификации

1. **CONSENT-05 и §2.1.** 03-checks §2.1 и wording guide §5.20 разрешают находки при `inconclusive` только у `locked`-вариантов CONSENT-04, а §4 шаг 10 требует `inconclusive` при недоступном pagehide. Прототип оставляет установленные находки CONSENT-05 при `inconclusive` (S-33). Подтвердить или поправить §2.1.
2. **MAIL-02 и Null MX (Q10 в §3.11).** В реестре нет варианта для Null MX; домен с Null MX без SPF теперь даёт `warning record-not-found`, а не `info`.
3. **`identifier.kind` в коллекторе.** 5.3 и D05 описывают признак как извлекаемый в коллекторе. В прототипе коллектор сохраняет исходные признаки (`identifierNames`, `matchesStoredIdentifier`, `sentCookieNames`, `parserVersion`), а `kind` вычисляет `derive` с сигнатурой каталога; пересчёт по снимку остаётся честным. Перенос классификации в коллектор потребует каталога в коллекторе — решить на этапе 3а.
4. **`CONSENT-02.cmp-cookie-with-uid`.** Вариант объявлен, но не выдаётся: нужен безопасный признак UID в consent-cookie, извлекаемый коллектором до удаления значения.
