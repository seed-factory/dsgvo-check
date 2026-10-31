# ADR-0010 — User-Agent, детектор бот-режима и гео-сигналы

Этот документ фиксирует, как сканер представляется сайту и что делает, когда CMP переключается в режим «бот» или «вне региона». Нужен разработке браузерного коллектора, авторам CONSENT-проверок и заказчику, который решает вопрос 3.

## Статус

`Proposed` — ждёт ответа заказчика на вопрос 3 «User-Agent браузера» по данным спайка С1 и на вопрос 12 «Egress для доказательных аудитов» ([раздел 8](../consensus/README.md#8-вопросы-заказчику)). До ответа действует буква ТЗ. D10 — спор 2:1:1: Sol-К и Terra-К — буква ТЗ; Opus-К — Chrome UA и токен со ссылкой, адрес которой выбирает заказчик (совместимо с решением); Fable-К — токен без URL и заголовок `X-…`. D11: механизм гео — единогласно; `critical` CONSENT-03 по заявлению пользователя — решение модератора (Sol-К и Terra-К против).

## Контекст

- ТЗ: «честный User-Agent со ссылкой на репозиторий».
- Статическая таблица ресёрча (регулярки из исходников, browser-automation §3.2): строку `Chrome/156 … dsgvo-check/0.1 (+https://github.com/…)` ловят только `isbot` (`http`, `\.com\b`, `check\b`) и Real Cookie Banner (копия той же регулярки, `check`); само имя `dsgvo-check` попадает под `check\b`. Cookiebot `isSpider`, Complianz `cmplz_is_bot` и Borlabs 3.5 `isBot` её не ловят, пока в UA нет `bot`, `crawler`, `spider`, `robot`. Usercentrics v3 ловит `HeadlessChrome` и `Playwright/` (эффект не изучен); CCM19 и CookieHub не проверены. В рантайме таблица не подтверждена.
- Что CMP делает с ботом: RCB по умолчанию `accept-all-for-bots: true`; Borlabs при `cookiesForBots` сохраняет «принять всё»; Cookiebot для `isSpider()` вызывает `setOutOfRegion()`; Complianz возвращает `cmplz_has_consent() === true`.
- Ложные CONSENT-01/02/03 из-за бот-режима хуже пропусков: они роняют CI клиенту, у которого всё в порядке.
- Гео: hosted runners GitLab.com — `us-east1`; регион GitHub-раннеров не документирован (⚠ проверить, факт 9). Cookiebot вне региона ставит `CookieConsent=-1`, Usercentrics может работать в фоне без баннера.

## Решение

1. **UA по умолчанию — буквально по ТЗ.** HTTP-пробы (undici): `dsgvo-check/<ver> (+https://github.com/<org>/<repo>; passive DSGVO/security check)`. Браузер: `navigator.userAgent` запущенного Chrome for Testing с заменой `HeadlessChrome/` на `Chrome/` (или шаблон Chrome с major из `browser.version()` — сам метод возвращает только версию) плюс тот же токен со ссылкой; в фазе M — мобильный шаблон с согласованными `userAgentMetadata`. TLS-handshake HTTP-заголовков не несёт, UA у него нет. Без кастомных заголовков, без `DNT` и `Sec-GPC`; `From:` только по `--contact`, в отчёт не попадает. `brands` в Client Hints не подменяются (это была бы маскировка).
2. **Детектор бот-режима обязателен** независимо от UA: только прямые сигналы — Cookiebot `isSpider()`, ветка RCB `accept-all-for-bots`, Complianz `cmplz_has_consent` без consent-cookie при `region: eu` и т. п. Сигнал → затронутые проверки `inconclusive` и диагностика `SCAN-BOTMODE`. Consent-cookie без клика сама по себе бот-режим не доказывает (может быть default-state CMP или дефект сайта).
3. **Гео-сигналы читаются всегда:** Cookiebot `isOutOfRegion` и `CookieConsent=-1`, `__ucCmp.isConsentRequired()`, `complianz.region`, гео-диалог Borlabs, `__tcfapi('ping').gdprApplies`. Сигнал → `inconclusive` и `SCAN-GEO`. Отсутствие CMP-скрипта и список `region` в Consent Mode гео-сигналом не считаются.
4. `scan.environment.egress = {mode: direct/proxy, region: unknown/asserted, source, collectors}`. `--proxy` (в 1.0 только `http://` — HTTP CONNECT) для браузера, undici и TLS; DNS идёт к резолверу напрямую, это пишется в `egress.collectors` и Messumgebung ([ADR-0016](0016-isolation-sandbox-and-egress-proxy.md)). `--proxy` и `--assume-region eea/de` записываются как «laut Nutzerangabe» без претензии на проверку; внешний «what is my IP» не вызывается. Термин — EWR, не «EU». CONSENT-03 даёт `critical` только при `region: asserted` (EWR), текст находки всегда содержит «Region laut Nutzerangabe». Что одного заявления пользователя достаточно для `critical`, решил модератор; Sol-К и Terra-К считали иначе — вопрос 12, уровень `verified-by-operator` — бэклог.
5. Профиль посетителя: `locale: de-DE`, `timezoneId: Europe/Berlin`; stealth-плагины, обход CAPTCHA и WAF запрещены; 403 или челлендж на старте → `SCAN-BLOCKED`.

## Рассмотренные варианты

| Вариант | Плюс | Минус |
|---|---|---|
| (а) Буква ТЗ + детектор (выбран по умолчанию; Sol-К, Terra-К) | Выполняет ТЗ; бот-режим становится `inconclusive`, не ложной находкой | Доля `inconclusive` на RCB- и `isbot`-сайтах неизвестна до С1 |
| (б) Chrome UA + токен без URL в браузере, ссылка в HTTP-пробах и на странице проекта (Fable-К) | Проходит `isbot` и регулярки CMP, меньше `inconclusive` | Поправка ТЗ; имя `dsgvo-check` всё равно под `check\b` — возможно переименование (D27) |
| (в) Идентифицирующий заголовок `X-Dsgvo-Check` (Fable-П) | UA чистый | Делает запросы «непростыми» (CORS-preflight — ⚠ проверить), не добавляется через CONNECT в HTTPS, уходит всем третьим лицам; буквы ТЗ не выполняет — отклонён |
| Дефолтный UA без override | Ничего не делать | `HeadlessChrome` есть в UA в обоих headless-режимах; его ловят `isbot`, RCB, Usercentrics v3 |
| Бот-режим → `warning` (ресёрч R1) | Видно в отчёте | Роняет `--fail-on warning` из-за ограничения измерения |

## Последствия

- Спайк С1 — рантайм-подтверждение статической таблицы на CMP-лаборатории (буквальный UA, токен без URL, чистый Chrome UA; 7 CMP), отдельно Usercentrics, CCM19, CookieHub и лениво подгружаемые чанки. Переход на (б) рекомендуется, если бот-режим при буквальном UA покажет хотя бы один из Borlabs, Cookiebot, Complianz (20 из 25 CMP-находок каталога).
- Имя, организация и домен фиксируются до этапа 1 (входят в UA, `$id` схемы, GHCR, `action.yml`); в `<org>/<repo>` не должно быть `bot`, `crawler`, `spider`, `robot` — Borlabs ловит `bot` в UA (вопрос 7).
- Для доказательных аудитов заказчика рекомендован EWR-egress (`--proxy` или self-hosted runner в DE, `--assume-region de`, `--strict`) — вопрос 12.
- Гипотезы о бот- и гео-режиме сохраняются в evidence вместе с limitation и не подавляются.

## Ссылки

- Консенсус: [D10, D11, D27](../consensus/README.md#2-итоговые-решения); [§3 D10, D11](../consensus/README.md#3-подробности-по-спорным-точкам-и-точкам-изменённым-меньшинством); [§5.7](../consensus/README.md#57-сетевая-граница-egresspolicy); ошибки 15, 16, 33, 40, 48, 63, 75, 76, 97; непроверенные факты 1, 9, 15; риск 1; вопросы 3, 7, 12; [errata №3, 12, 41, 45, 46](../consensus/round-4/errata.md).
- Критика: [Sol-К D10, §4.5](../consensus/round-3/codex-gpt-6.1-sol_critique.md), [Terra-К D10](../consensus/round-3/codex-gpt-6.1-terra_critique.md), [Opus-К D10](../consensus/round-3/claude-opus-5.5_critique.md), [Fable-К D10, §4.2](../consensus/round-3/claude-fable-5.1_critique.md); [votes-matrix D10](../consensus/round-3/votes-matrix.md#d10).
- Предложения: [Opus-П §3.7–3.9](../consensus/round-2/claude-opus-5.5_proposal.md), [Sol-П §3 «Нагрузка, UA, гео»](../consensus/round-2/codex-gpt-6.1-sol_proposal.md).
- Ресёрч: [browser-automation §3–4, §10](../01-research/browser-automation.md); [R1-ТЗ §3.1](../consensus/round-1/codex-gpt-6.1-sol_tz-analysis.md).
