# ADR-0001 — TypeScript + Playwright как язык и браузерный движок

Этот документ фиксирует стек сканера `dsgvo-check`, чтобы все остальные решения (тулчейн, образ, тесты, контракты) опирались на одну платформу. Нужен разработке и ревьюерам: именно на эту запись ссылаются ADR по браузеру, дистрибуции и тулчейну.

## Статус

`Accepted` — зафиксировано заказчиком в [исходной идее](../../specs/dsgvo-check_idea.md) («Язык и стек: TypeScript + Playwright»). Дата: 2026-10-30.

## Контекст

- [ТЗ](../../specs/dsgvo-check_TZ.md) оставляет язык «любой, в разумных пределах» и браузер «Playwright или что угодно, что умеет перехватывать сеть и кликать баннер». Заказчик закрыл свободу выбора в идее: TypeScript + Playwright.
- Проект — CLI для CI, который открывает недоверенные сайты, перехватывает сеть, cookies и хранилища, кликает по баннеру CMP и печатает HTML/PDF. Движку нужны: события сети до первой навигации, CDP-доступ (`initiator`, `blockedCookies`, `Audits`), persistent-профили, эмуляция мобильного viewport, печать PDF.
- Почти все аналоги на Chromium (WEC — Puppeteer, Blacklight — Puppeteer, Lighthouse — CDP, gdpr-cookie-scanner — Playwright); сопоставимость результатов с ними важна для заказчика-аудитора.
- Экосистема вокруг проверок (autoconsent, retire.js, third-party-web, zod, Ajv, undici) — npm-пакеты; единый рантайм убирает мост между языками.

## Решение

- Язык — TypeScript (версия и компилятор — в [ADR-0018](0018-toolchain-and-repository.md)); рантайм — Node.js.
- Браузерная автоматизация — Playwright через зависимость `playwright-core` с точным пином (1.64.x, Chrome for Testing 156); пакет `playwright` с тест-раннером не используется.
- Эталонный движок — Chromium в режиме Chrome for Testing «new headless» (`channel: 'chromium'`), не `chromium-headless-shell`: shell отдаёт `HeadlessChrome` в `Sec-CH-UA` даже при подменённом UA. Firefox и WebKit не поддерживаются.
- Наблюдение сети — `context.on('request' | 'response' | 'requestfinished' | 'requestfailed')` с подпиской до первой навигации плюс CDP-сессия; `page.route()` для наблюдения не используется (отключает HTTP-кэш). Пять фаз идут в четырёх свежих `launchPersistentContext(tmpdir)` — A (с A′ в конце), B, C, M ([ADR-0009](0009-consent-phases.md)); сравнение с `newContext()` закрывает спайк С2.
- Небраузерные коллекторы — `undici` (HTTP), `node:tls`, `node:dns`; небраузерный стек не выносится в другой язык или внешний процесс.

## Рассмотренные варианты

| Вариант | Плюс | Минус |
|---|---|---|
| TypeScript + Playwright (выбран) | Один рантайм для браузера, HTTP/DNS/TLS и данных; CDP и persistent-профили из коробки; закреплено заказчиком | Chromium-only; `playwright-core` жёстко связан с версией браузера, апдейты обязательны |
| TypeScript + Puppeteer (как WEC и Blacklight) | Сопоставимость с EDPS WEC; тоньше слой над CDP | Нет встроенной мульти-браузерной абстракции, слабее actionability-проверки при клике, образы и `install --with-deps` менее удобны |
| Python + Playwright (как consentcrawl) | Быстрая аналитика, pdfjs/scikit под рукой | Второй рантайм для npm-экосистемы данных; GitHub Action и npm-дистрибуция сложнее |
| Go + chromedp или Nuclei-подобный движок | Один бинарник, быстрый HTTP | Нет зрелых CMP-библиотек и retire.js; тестовые фикстуры браузера беднее |
| Headless shell вместо полного Chrome for Testing | Образ на ~75 МБ меньше | Бренд `HeadlessChrome` остаётся в `Sec-CH-UA` и `navigator.userAgentData` даже после подмены UA — явный признак автоматизации; подменять brands — маскировка |

## Последствия

- Все зависимости — npm; лицензионный allowlist и `datasets.lock.json` живут в одном `package.json` ([ADR-0013](0013-service-catalog-and-data-licenses.md), [ADR-0018](0018-toolchain-and-repository.md)).
- Образ несёт полный Chrome for Testing (~200 МБ в архиве) — цена достоверности поведения CMP.
- Обновления `playwright-core` идут одной группой Renovate с `ARG` Dockerfile (кандидат ADR-033 — предложение модератора к этапу 4): сканер открывает недоверенные сайты, патчи Chromium — вопрос безопасности.
- Playwright по умолчанию отключает `ThirdPartyStoragePartitioning` и `HttpsUpgrades`: первое — ограничение достоверности и пишется в «Messumgebung», второе полезно для TLS-01 (редирект обязан сделать сервер).
- Поддержка Windows и macOS в npm-режиме — best effort; эталон — Linux-образ.

## Ссылки

- Заказчик: [идея, «Зафиксированные решения»](../../specs/dsgvo-check_idea.md); [ТЗ, «Свобода выбора»](../../specs/dsgvo-check_TZ.md).
- Консенсус: [D07, D24](../consensus/README.md#2-итоговые-решения); кандидат ADR-011 «Браузер» в [разделе 10](../consensus/README.md#10-adr-кандидаты).
- Ресёрч: [browser-automation, §0 и §3.1](../01-research/browser-automation.md), [prior-art, §2 и §10](../01-research/prior-art.md), [engineering, §0](../01-research/engineering-ci-distribution.md).
- Предложения: [Opus-П §2.7, §3.2](../consensus/round-2/claude-opus-5.5_proposal.md), [Fable-П §10](../consensus/round-2/claude-fable-5.1_proposal.md).
