# Инженерный ресёрч: тулчейн, тесты, CI, дистрибуция и безопасность `dsgvo-check`

> Статус: анализ, код не пишем. Дата: 2026-10-30. Автор: Claude (Opus 5.5), участник консенсус-панели.
> Версии пакетов сняты из npm registry (`npm view …`), версии Node взяты с nodejs.org/dist, размеры образов посчитаны по манифестам mcr.microsoft.com и Docker Hub в день написания. Всё, что подтвердить не удалось, помечено «⚠ проверить».
> Рядом лежат смежные отчёты: `data-sources-and-licenses.md`, `http-dns-tls-mail.md`, `prior-art.md`. Здесь только инженерная часть.

---

## Коротко

1. **Стек на 2026-10-30.** Node 26 стал Active LTS 28.10.2026. Node 24 перешёл в Maintenance 20.10.2026 и поддерживается до 30.04.2028. На Node 24 построены официальные образы Playwright и runtime JS-actions в GitHub, поэтому для образа и Action берём 24. В CI-матрицу ставим 22/24/26, в `engines` пишем `>=22.12`. Остальное: **TypeScript 7.0.2** (нативный `tsc`), **Playwright 1.64.1** (зависимость `playwright-core` с точным пином), **pnpm 11.x**, **Vitest 5.0.5**, **Biome 2.6** и `oxlint-tsgolint` для правил про промисы. Pnpm 12 сейчас `latest`, но это переписанный на Rust менеджер, которому около двух месяцев. typescript-eslint 8.72 с TS 7 не работает: в peer-зависимостях `typescript <6.1.0`.
2. **Архитектура.** Цепочка такая: collectors собирают сырые данные в JSON-артефакты, checks (чистые функции) превращают их в findings, reporters выводят результат. Это модель gatherers/audits из Lighthouse. Она решает требование ТЗ «новая проверка без правок ядра»: проверка — это папка плюс строка в реестре слоя checks. И она позволяет тестировать проверки без браузера.
3. **Репозиторий.** pnpm-workspace, в котором публикуется один npm-пакет `dsgvo-check` (CLI и программный API). Фикстур-сервер и тест-утилиты лежат там же как приватные пакеты. SDK для плагинов выносим отдельно, когда появится первый внешний плагин (по каталогу это BFSG-01). Отдельные репозитории понадобятся для примера «красной» сборки и для GitLab-проекта компонента: Catalog работает только в пределах одного инстанса GitLab.
4. **Тесты.** Четыре уровня:
   - **L1**: юнит-тесты на записанных артефактах. Минимум две фикстуры на проверку (нарушение и чисто), без браузера. Это дешёвый способ закрыть требование ТЗ.
   - **L2**: Chromium в контейнере `--network none`. Сторонние домены через `--host-resolver-rules` уходят на локальный мульти-хост сервер с тестовым CA, DNS обслуживает dns2.
   - **L3**: e2e для CLI, Docker-образа и самого Action.
   - **L4**: ночная канарейка на 10 сайтах заказчика. Её нужно запускать **в приватном репозитории**: логи и артефакты публичного репозитория видны всем.
5. **Отчёт.** Схема пишется на zod 4 и экспортируется в JSON Schema 2020-12, файл коммитится. Ajv проверяет по ней golden-отчёты в контрактных тестах. `schemaVersion` — отдельный semver, не связанный с версией тула. Fingerprint считается как хеш от стабильного ключа проверки, без query-строк и значений cookies. Файл baseline/suppress требует `reason` и `expires`. **SARIF и GitLab Code Quality в MVP не берём**: оба формата требуют путь к файлу и номер строки, а у веб-находки их нет. **JUnit и GitHub Job Summary берём.**
6. **GitHub Action** делаем как **composite-обёртку над `docker run`** образа, закреплённого по digest. Так мы сами задаём флаги изоляции (не root, seccomp, cap-drop, лимиты) и не пускаем в контейнер служебные токены раннера. У Docker-action по документации GitHub контейнер работает **только от root**, а под root Chromium-sandbox недоступен. JS-action или `npx` остаются запасным путём для macOS, Windows и раннеров без Docker.
7. **GitLab.** Публикуем компонент в CI/CD Catalog на gitlab.com. Для self-managed даём `include:remote` с `integrity` (доступно с GitLab 17.9): зеркалирование компонентов между инстансами есть только в Premium/Ultimate. **Docker**: свой образ `node:24-*-slim` плюс только Chromium. Официальный `mcr.microsoft.com/playwright:v1.64.1-noble` весит около 984 МБ в сжатом виде, тащит все браузеры и по умолчанию работает от root. Образ multi-arch (amd64 и arm64), собирается нативно на arm-раннерах, публикуется в GHCR.
8. **Браузер в npm-режиме** ставится явной командой (`dsgvo-check install`), а не через postinstall. В pnpm 11 по умолчанию `strictDepBuilds=true`, и непроверенный build-скрипт зависимости ломает установку.
9. **Безопасность сканера — главный инженерный риск.**
   - Playwright по умолчанию запускает Chromium **без sandbox** (`chromiumSandbox: false`) и **принимает скачивания** (`acceptDownloads: true`). Оба дефолта меняем на противоположные.
   - Браузер получает очищенный `env`.
   - Запросы в private, loopback и link-local сети блокируются, если сам сайт не в этих сетях (IMDS, DNS-rebinding).
   - HTML-отчёт статичный: без JS, без внешних ресурсов, с CSP. Строки с чужих сайтов очищаем перед выводом в терминал и перед workflow-командами GitHub.
10. **Достоверность: геотаргетинг CMP и распознавание ботов.** Регион GitHub-hosted раннеров выбрать нельзя ⚠. По заявлению самого Cookiebot, поисковым краулерам он показывает «полное согласие» ⚠. Отсюда ложные CONSENT-01/03. Что нужно:
    - UA без `bot`, `crawler` и `Headless`;
    - `de-DE` и `Europe/Berlin`;
    - опция `--proxy` для выхода в сеть из ЕС;
    - запись в отчёт, откуда был выход в сеть.

    **Релизы**: release-please v5, npm Trusted Publishing (OIDC, provenance) плюс staged publishing с подтверждением через 2FA, Renovate, OpenSSF Scorecard.

---

## 0. Актуальные версии (проверено 2026-10-30)

| Компонент | Актуально | Дата | Рекомендация | Почему |
|---|---|---|---|---|
| Node.js | 26.13.0 «Lithium», Active LTS с 2026-10-28; 24.22.2 «Krypton», Maintenance с 2026-10-20, EOL 2028-04-30; 22 Maintenance, EOL 2027-04-30; 20 EOL с 2026-04-30 | — | Образ и Action: **24**. CI: 22/24/26. `engines: ">=22.12"` | Официальный образ Playwright собран на `NODE_VERSION=24`, JS-actions исполняются на `node24`. Vitest 5 и commander 15 требуют `^22.12` или новее. С 25-й версии Node не поставляет Corepack ⚠ |
| TypeScript | 7.0.2 (`latest`), 7.1.0-beta, 6.0.3 | 2026-07-08 / 2026-04-16 | **7.0.2** для typecheck и emit, 6.0.3 как запасной вариант | Пакет 7.0 экспортирует только `./unstable/*` и `lib/version.cjs`, классического JS API нет. Стабильный API ждут в 7.1 (вторичные источники). typescript-eslint 8.72.1 требует `typescript >=4.8.4 <6.1.0` |
| Playwright | 1.64.1 (Chromium 156.0.8078.4); 1.65 в alpha | 2026-10-14 | `playwright-core@1.64.1`, точный пин | 1.63 перевёл Linux arm64 на сборки Chrome for Testing. В 1.61 появились `apiResponse.securityDetails()` и `serverAddr()` |
| pnpm | 12.16.1 (`latest`, Rust-переписывание, 12.0.0 от 2026-08-26); 11.28.9 (`latest-11`) | 2026-10-27 | **11.x**, к 12 вернуться в I кв. 2027 | В 11 по умолчанию: `minimumReleaseAge` 1 день, `strictDepBuilds=true`, `blockExoticSubdeps=true`, Node ≥22. За два месяца у 12-й ветки 16 минорных релизов, это признак нестабильности |
| Vitest | 5.0.5 (`V4`=4.1.12) | 2026-10-15 | **5.x** | Node `^22.12 \|\| ^24 \|\| >=26`. Невызванные через await async-ассерты теперь падают, и это полезно против флейков |
| ESLint | 10.13.0 | 2026-10-16 | не брать (см. Biome) | Вместе с TS 7 работает только без type-aware правил |
| Biome | 2.6.4 | 2026-10-28 | **форматтер и линтер** | `noFloatingPromises` пока в nursery |
| oxlint (+ oxlint-tsgolint) | 1.90.0 | 2026-10-27 | **только type-aware правила** (`no-floating-promises`, `no-misused-promises`) | tsgolint построен на typescript-go и требует TS ≥7.0 |
| tsup | 9.0.0 | 2026-10-14 | нет | В README прямо написано: «not actively maintained… consider tsdown» |
| tsdown | 0.23.4 (rolldown ~1.2) | 2026-10-29 | только если понадобится бандл | Версия до 1.0. CLI-пакету для Node бандл не нужен |
| unbuild | 3.6.1 | 2025-08-15 | нет | Больше года без релизов |
| zod / typebox / valibot / ajv | 4.6.7 / 1.4.3 / 1.5.0 / 8.20.0 | 2026-10 / 10 / 09 / 04 | **zod 4 + ajv 8** | В zod 4 встроен `z.toJSONSchema()`, отдельный `zod-to-json-schema` не нужен |
| commander | 15.0.0 | 2026-05-29 | да | MIT, без зависимостей, Node ≥22.12 |
| release-please / action | 17.11.2 / **v5.0.0** | 2026-08-24 / 2026-04-22 | да | — |
| changesets | 3.0.3 | 2026-09-14 | альтернатива | — |
| cosign | v3.1.4 | 2026-10-20 | да (или `actions/attest@v4`) | По умолчанию формат bundle, Rekor v2 |
| ossf/scorecard-action | v2.5.0 | 12 окт. (2026 ⚠) | да | — |
| dns2 | 3.1.1, MIT | 2026-07-26 | для L2 | — |
| `@duckduckgo/autoconsent` | 17.1.0, MPL-2.0 | — | как источник правил CMP | В тарболе есть правила для всех 7 CMP из каталога (см. §1.5) |

**Размеры (по манифестам реестров):**

| Артефакт | Размер |
|---|---|
| `mcr.microsoft.com/playwright:v1.64.1-noble` | amd64 **983.9 МБ** в сжатом виде, arm64 958.2 МБ. Внутри Node 24, `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`, `USER` не задан, то есть root |
| `node:24-trixie-slim` / `node:26-trixie-slim` | ≈83 / ≈86 МБ в сжатом виде |
| `chrome-headless-shell-linux64.zip` (CfT 156.0.8078.4) | 125.8 МБ |
| `chrome-linux64.zip` (полный CfT, нужен для new headless) | 200.3 МБ |
| Свой образ «slim + headless shell + системные зависимости» | оценка 300–450 МБ в сжатом виде ⚠ замерить |

---

## 1. Структура репозитория

### 1.1 Варианты

| Критерий | A. Один пакет в корне | B. Workspace, один публикуемый пакет плюс приватные | C. Монорепо `core`/`checks`/`cli`/`sdk`, всё публикуется |
|---|---|---|---|
| Простота для пользователя (`npx dsgvo-check`) | да | да | да (мета-пакет) |
| Конфиг релизов | минимальный | release-please в режиме одного пакета | changesets или release-please manifest, синхронные версии |
| Изоляция тест-инфраструктуры от runtime-зависимостей | через `files` и devDeps | естественная | естественная |
| Переиспользование фикстур-сервера авторами плагинов и примером | неудобно | можно опубликовать позже | да |
| Цена на старте | 0 | низкая | заметная: публичный API пакетов с первого дня |
| **Вердикт** | годится | **рекомендую** | преждевременно |

### 1.2 Рекомендуемая раскладка

```
dsgvo-check/
├─ action.yml                       # composite Action; Marketplace требует один action.yml в корне
├─ action/seccomp.json              # профиль для Chromium-sandbox в docker run
├─ packages/
│  ├─ dsgvo-check/                  # единственный публикуемый пакет (bin + программный API)
│  │  ├─ src/core/                  # движок, модель Artifact/Finding, порог, exit-коды, интерфейсы реестра
│  │  ├─ src/collectors/{browser,http,tls,dns}/
│  │  ├─ src/checks/<check-id>/     # проверка = папка (код, тесты, фикстуры)
│  │  ├─ src/checks/index.ts        # список проверок: слой checks, не ядро
│  │  ├─ src/report/{json,console,html,junit,gh-summary}/
│  │  ├─ src/cli/
│  │  └─ data/                      # YAML-источники → при сборке валидируются и компилируются в JSON
│  │     ├─ services/*.yaml         # каталог сервисов (домены → вендор, категория, страна, термины для PRIV-01)
│  │     ├─ cmp/*.yaml              # детект CMP и кнопки первого уровня (CONSENT-04)
│  │     ├─ messages/{de,en}.yaml   # тексты находок (§7)
│  │     └─ vuln/                   # индекс CVE/KEV (источник выбирается на этапе 0)
│  ├─ fixture-server/   (private)   # мульти-хост HTTP(S) + DNS + тестовый CA
│  └─ test-utils/       (private)   # нормализация снапшотов, фабрики артефактов
├─ schemas/report.v1.json, config.v1.json   # генерируются из zod, коммитятся, CI проверяет расхождение
├─ docker/Dockerfile
├─ gitlab/templates/dsgvo-check.yml         # синхронизируется в GitLab-проект компонента
├─ docs/  (ADR, threat model, docs/checks/*.md генерируются из реестра)
└─ .github/workflows/{ci,release,nightly,scorecard,codeql}.yml
```

Отдельные репозитории:
- `dsgvo-check-example`: «красная» сборка для этапа 2, см. §4.7;
- `gitlab.com/<group>/dsgvo-check`: компонент CI/CD Catalog, только `templates/`, README и `.gitlab-ci.yml` с job'ом `release`;
- `dsgvo-check-canary`: **приватный**, ночные прогоны по реальным сайтам.

### 1.3 Конвейер и границы модулей

```
CLI/config ─► Engine ─► выбирает checks ─► выводит нужные collectors (requires/provides)
                         │
   collectors: browser (Playwright) │ http (undici) │ tls (node:tls) │ dns (Resolver)
                         ▼
                 Artifacts (сериализуемый JSON, с версией)  ◄── --save-artifacts / --from-artifacts
                         ▼
   checks: чистые функции (artifacts, ctx) → Finding[]   (без I/O, без браузера)
                         ▼
   post: suppress/baseline → threshold → exit code
                         ▼
   reporters: json │ console │ html(→pdf) │ junit │ gh-summary
```

Правила зависимостей проверяются линтером (импорт-ограничения в Biome) и тестом на граф импортов:
- `core` не импортирует ни `checks`, ни `collectors`; реестр передаётся ему снаружи;
- `checks/*` импортирует только `core/api`, без Playwright и без `node:*` I/O;
- `collectors` ничего не знают о проверках, они только публикуют типизированные артефакты.

Режимы `--save-artifacts` и `--from-artifacts` повторяют `--gather-mode` и `--audit-mode` из Lighthouse. Через них реальный прогон превращается в регрессионную фикстуру L1 (§2.2).

### 1.4 Как добавляется проверка «без правок ядра»

Контракт (иллюстрация, это не финальный API):

```ts
// src/checks/embed-01/index.ts
export default defineCheck({
  id: 'EMBED-01', crmCode: 'T1_FONTS_EXTERNAL', priority: 'P0', module: 'browser',
  defaultSeverity: 'critical',
  requires: ['network.preConsent', 'catalog.services'],        // движок поднимет только нужные collectors
  fingerprintKey: (f) => [f.evidence.registrableDomain],        // §3.5
  run: (a, ctx) => a.network.preConsent
    .filter((r) => ctx.services.category(r.host) === 'fonts' && !ctx.isFirstParty(r.host))
    .map((r) => ctx.finding({ evidence: { type: 'request', url: r.url, host: r.host } })),
});
```

| Механизм реестра | Плюсы | Минусы | Вердикт |
|---|---|---|---|
| Обход файловой системы в runtime (glob) | ноль ручных правок | ломает бандлинг, порядок недетерминирован, типы проверок теряются, запускается код, найденный на диске | нет |
| Codegen индекс-файла | автоматически, статические импорты | лишний шаг сборки, CI должен проверять, что индекс актуален | допустимо |
| **Явный список в `src/checks/index.ts`** плюс тест полноты | типобезопасно, видно в PR, без магии | одна строка на проверку, но в слое checks, а не в ядре | **рекомендую** |
| Внешние пакеты-плагины (`--plugin pkg`, `plugins: []` в конфиге) | расширяемость для третьих лиц, BFSG-01 как «отдельный плагин» | нужен версионированный API (`apiVersion`), плагин — это исполняемый код | **P2**, только явное подключение; автозагрузку `dsgvo-check-plugin-*` из `node_modules` не делать (риск цепочки поставок) |

**Тест полноты реестра** проверяет каждую проверку и ловит забытое:
- папка зарегистрирована;
- есть `fixtures/violation.*` и `fixtures/clean.*`;
- есть ключи сообщений в `de` и `en`;
- есть `crmCode` из каталога;
- есть страница в `docs/checks/`;
- ID уникален.

### 1.5 Данные и лицензии (кратко, подробности в `data-sources-and-licenses.md`)

| Источник | Лицензия (проверено) | Пригодность |
|---|---|---|
| Open Cookie Database | Apache-2.0 (LICENSE в репозитории) | ✅ с атрибуцией в NOTICE |
| `@duckduckgo/autoconsent` 17.1.0 | MPL-2.0 (npm) | ✅ как зависимость или копия правил в отдельной папке с заголовками MPL. В пакете есть `rules/autoconsent/borlabs.json`, `ccm19.json`, `complianz-*.json`, `cookiehub.json`, `real-cookie-banner.json`, `usercentrics-*.json`, а также `lib/cmps/cookiebot.ts`, то есть все 7 CMP из каталога. Но задача autoconsent — отказ любой ценой, хоть со второго уровня. Для CONSENT-04 нужен свой признак «есть равноценная кнопка отказа на первом уровне» |
| Consent-O-Matic | MIT | ✅ |
| DuckDuckGo Tracker Radar, Disconnect, `@ghostery/trackerdb` | CC BY-NC-SA 4.0 | ❌ запрет коммерческого использования, а заказчик проводит аудиты за деньги |
| DB-IP «IP to Country Lite» | CC BY 4.0, обновление ежемесячно, нужна ссылка на db-ip.com | ✅ как вспомогательное доказательство. Страна IP-адреса не равна месту обработки данных (anycast/CDN), юридический вывод делает заказчик |

Формат данных:
- источник — YAML (комментарии, удобно ревьюить);
- при сборке файлы валидируются zod-схемой и компилируются в JSON внутри `dist/`;
- в runtime YAML-парсер не нужен.

---

## 2. Тесты

### 2.1 Пирамида

| Уровень | Что проверяет | Инструменты | Сеть | Гейтит PR | Бюджет |
|---|---|---|---|---|---|
| L0 статика | типы, линт, валидность `data/*.yaml`, полнота сообщений de/en, лишние формулировки (§7), полнота реестра, актуальность схемы и README | `tsc`, Biome, oxlint-tsgolint, Vitest | нет | да | < 1 мин |
| L1 юнит | каждая проверка на записанных артефактах: `violation` даёт ≥1 находку с ожидаемым ID и уровнем, `clean` даёт 0; fingerprint; suppress; порог; exit-коды; рендер отчётов | Vitest | нет | да | < 30 с |
| L2 интеграция | collectors плюс checks на локальных фикстур-сайтах с Chromium; TLS/DNS/HTTP-пробы | Vitest + `playwright-core`, fixture-server, dns2 | **`--network none`** | да | < 5–7 мин |
| L3 e2e | CLI в собранном Docker-образе, exit-коды 0/1/2, `uses: ./` (Action на самом себе), JUnit/HTML-артефакты | GitHub Actions, docker | только локальная | да | < 5 мин |
| L4 канарейка | 10 реальных сайтов заказчика, сверка с ожиданиями | cron в **приватном** репозитории | интернет | нет | ночью |

Раннер тестов — **Vitest** для L1–L2: одни снапшоты, одна конфигурация, раздельные `projects` для unit и integration. Раннер `@playwright/test` не нужен: тесты гоняют наш сканер, а уже он управляет браузером. Playwright в тестах появляется только как библиотека.

### 2.2 Записанные артефакты

- `Artifacts` — версионированный JSON. В нём запросы (метод, URL, тип ресурса, initiator, фаза: до согласия или после отказа), ответы (статус, заголовки, `serverAddr`, `securityDetails`), снимки cookies по фазам, DOM-факты (ссылки в подвале, найденный CMP, кнопки), DNS-записи, TLS-пробы, HTTP-пробы.
- Фикстура L1 для проверки — это два файла: `violation.artifacts.json` и `clean.artifacts.json`. Пишутся руками или снимаются с L2-прогона через `--save-artifacts` и потом урезаются.
- Если канарейка ловит регрессию, фикстура берётся с реального сайта. Перед коммитом обязательна очистка: значения cookies, тела ответов и персональные данные удаляются, остаются только метаданные. Из-за авторских прав и персональных данных тела сторонних ресурсов в публичный репозиторий не кладём.

### 2.3 Сеть без интернета для L2

| Способ | Достоверность | Сложность | Подводные камни |
|---|---|---|---|
| **`--host-resolver-rules="MAP * 127.0.0.1, EXCLUDE localhost"`** плюс мульти-хост сервер (по Host/SNI) | высокая: настоящие TLS, cookies, third-party-контекст, `serverAddr` | средняя | Поддержка переназначения порта в `MAP host ip:port` для `--host-resolver-rules` не подтверждена ⚠. Обход: внутри контейнера слушать 80/443, это позволяет `--sysctl net.ipv4.ip_unprivileged_port_start=0` в собственном netns |
| `context.route()` + `route.fulfill()` | средняя: `serverAddr` и `securityDetails` = null, кеш выключен, применение `Set-Cookie` из fulfill нужно проверить ⚠ | низкая | Может конфликтовать с `route`-обработчиками самого сканера (блокировка private-сетей и т. п.) |
| Playwright `proxy` на локальный MITM-прокси | высокая | высокая | Прокси меняет поведение (HTTP/3 отключается). Имеет смысл, только если прокси всё равно появится в проде (§6.5) |
| `routeFromHAR` | средняя | низкая | HAR с реальных сайтов содержит чужой контент и cookies, в публичный репозиторий его нельзя |

**Рекомендация.**
- Основной способ — host-resolver-rules: он работает на сетевом уровне и не задевает логику сканера. `route` оставляем для узких компонентных тестов.
- **Таблица хостов одна на всё.** Фикстура объявляет карту `host → fixture`. Из неё генерируются (а) аргумент Chromium и (б) `lookup` для undici и `node:tls` через инжектируемый `Resolver`.
- Без этого Chromium и Node будут резолвить по-разному: Chromium через свой резолвер, Node через `getaddrinfo` или `/etc/hosts`.
- Сервер по SNI выпускает листовые сертификаты, подписанные тестовым CA (`@peculiar/x509` или `selfsigned`, обе MIT).
- Доверие к CA: в тестовом образе CA добавляется в NSS DB (`~/.pki/nssdb`). Видит ли этот CA headless shell, надо проверить ⚠.
- Запасной вариант — `ignoreHTTPSErrors: true`, но только в тестах, которые не касаются TLS.
- Любой запрос к хосту вне карты отдаёт 599 и роняет тест. Неучтённая сторонняя зависимость фикстуры — это баг теста.

### 2.4 TLS-фикстуры (для TLS-01/02/04, P0/P1)

| Кейс | Как поднять | Что ожидаем |
|---|---|---|
| Валидный (тестовый CA) | `tls.createServer` на 443 | чисто |
| Истёкший | сертификат с `notAfter` в прошлом, генерируется при старте теста | TLS-02 critical |
| Истекает через N дней | **часы инжектируются** (`ctx.now`), сертификат статичный | TLS-02 warning |
| Чужое имя (`*.alfahosting-server.de`) | SAN не совпадает с SNI | TLS-02 |
| Самоподписанный | без CA | TLS-02 |
| http без редиректа на https / без HSTS | HTTP-сервер на 80 | TLS-01 |
| Только TLS 1.0 | `minVersion/maxVersion: 'TLSv1'`, `ciphers: 'DEFAULT@SECLEVEL=0'`. Работает ли это с OpenSSL из Node 24/26, надо проверить ⚠ | TLS-04. Если не работает в Node, тест L1 и пометка; вариант с testssl.sh вне MVP |
| Смешанный контент | https-страница с `http://`-картинкой и скриптом | TLS-03 |

### 2.5 DNS-фикстуры (MAIL-01..03, DNS-01)

- Модули MAIL и DNS получают DNS только через интерфейс `DnsResolver`, который инжектируется.
  - L1: in-memory карта записей.
  - L2: настоящий UDP-сервер **dns2** на `127.0.0.1:<порт>` и `new dns.promises.Resolver().setServers(['127.0.0.1:<порт>'])`. Так тестируется настоящий разбор пакетов с wire-format.
- Обязательные кейсы:
  - TXT длиннее 255 байт приходит несколькими строками: `resolveTxt` возвращает `string[][]`, куски нужно склеить;
  - несколько SPF-записей;
  - `include:` с превышением лимита в 10 DNS-запросов;
  - DMARC на поддомене, но не на организационном домене;
  - NXDOMAIN вместо SERVFAIL. Это разные статусы: «нет записи» — находка, «DNS не ответил» — ошибка проверки.
- DNSSEC (P2): системный резолвер Node AD-флаг не валидирует. Понадобится запрос с DO-битом к валидирующему резолверу (DoH), решаем отдельно.

### 2.6 Имитация CMP

- Тексты и скрипты реальных CMP в репозиторий **не копируем**: Cookiebot и Usercentrics проприетарные, у Complianz и Borlabs код под GPL или проприетарный, авторские права и копилефт.
- Фикстуры пишем вручную: минимальная DOM-разметка с теми же опознавательными признаками (ID и классы контейнера, глобальные объекты вроде `Cookiebot`, `UC_UI`, `BorlabsCookie` ⚠ сверить с правилами autoconsent) плюс скриптовый конечный автомат. Он показывает баннер, по клику на «Ablehnen» или «Akzeptieren» ставит или не ставит трекеры, пишет consent-cookie.
- На каждый CMP минимум три фикстуры:
  - (а) равноценный отказ на первом уровне, ожидаем чисто;
  - (б) только «Zustimmen» и «Einstellungen», ожидаем CONSENT-04;
  - (в) неизвестный баннер, ожидаем `info` «Banner nicht erkannt» (требование ТЗ).
- Против дрейфа CMP-вендоров у нас только канарейка L4. Autoconsent решает ту же задачу живыми e2e-тестами (`tests/*.spec.ts` в пакете).

### 2.7 Golden и контрактные тесты

- **Golden JSON**: `toMatchFileSnapshot('golden/<check>.<case>.json')` в Vitest, чтобы читаемый diff был виден в PR.
- Перед снапшотом сериализатор нормализует данные:
  - время, длительность, порты, версии тула и Chromium, абсолютные пути заменяются на плейсхолдеры;
  - массивы сортируются по `fingerprint`.
- **Контрактные тесты**:
  - (1) каждый golden-отчёт и каждый отчёт L2/L3 валидируется Ajv (`ajv/dist/2020`) по `schemas/report.v1.json`;
  - (2) схема пересобирается из zod, и CI падает, если она разошлась с закоммиченной без бампа `schemaVersion`;
  - (3) обратная совместимость: отчёты-образцы прошлых минорных версий (`schemas/examples/1.0.0/*.json`) должны проходить текущую схему той же major-версии.
- **HTML-отчёт**: Chromium открывает `report.html` с `context.route('**', abort)` и проверяет три вещи: ноль сетевых запросов (кроме `data:`), ноль нарушений CSP в консоли, ни одной активной ссылки со схемой, отличной от http(s).

### 2.8 Канарейка (L4)

- Репозиторий **приватный**. Логи и артефакты Actions в публичном репозитории доступны всем, а отчёт о нарушениях конкретной названной компании в открытом доступе — это юридический риск (Prangerwirkung) для заказчика.
- Ожидания хранятся в `expectations/<site>.yaml`: списки `mustFind` и `mustNotFind` по ID проверок с комментарием аудитора. Размечает заказчик, это его эталон.
- Ночной прогон гоняет образ `edge` (сборка из main) и текущий релиз. Результат — таблица precision/recall по ID и diff между двумя образами. На дрейф открывается issue.
- Нестабильность отделяем от регрессии: недоступный сайт, таймаут или 5xx дают статус `unreachable`, а не провал. Повтор не чаще одного раза.
- Темп — один проход на сайт за ночь, честный UA. Согласие владельцев сайтов — открытый вопрос.

### 2.9 Правила против флейков

1. Никакого интернета в PR-тестах. Это гарантирует `--network none`, а не дисциплина.
2. Никаких `waitForTimeout` в тестах. Окно наблюдения сканера задаётся параметром. Фикстуры шлют трекеры сразу или с известной задержкой, которая меньше окна. Long-polling в фикстурах запрещён.
3. Порты динамические (`listen(0)`) везде, кроме 80/443 внутри изолированного netns.
4. Свежий browser context на каждый скан, без общего профиля. Браузер на воркер, `pool: 'forks'`, `maxWorkers: 2` на 4 vCPU.
5. Время инжектируется в проверки (срок сертификата, `expires` у suppress). `TZ=Europe/Berlin`, `LANG=de_DE.UTF-8` фиксированы.
6. В L1–L2 ретраев нет: флейк считается багом. Ночью L2 гоняется с перемешиванием порядка тестов (`--sequence.shuffle`) несколько раз, чтобы найти нестабильные тесты.
7. Версия Chromium жёстко привязана к версии Playwright. Обновления приходят PR от Renovate и проходят полный L2/L3.
8. Невызванные через await промисы ловят `no-floating-promises` (oxlint-tsgolint) и строгий режим async-ассертов в Vitest 5.

---

## 3. JSON-схема и форматы вывода

### 3.1 Чем описывать схему

| | zod 4.6 | TypeBox 1.4 (`typebox`) | valibot 1.5 |
|---|---|---|---|
| Источник JSON Schema | `z.toJSONSchema()` встроен (draft 2020-12; есть режимы `io: input/output`) | схема — это и есть JSON Schema | `@valibot/to-json-schema` |
| Ошибки валидации конфига для людей | лучшие | средние | хорошие |
| Популярность и найм | максимум | ниже | ниже |
| Вердикт | **да**: одна библиотека для конфига, отчёта и `data/*.yaml` | хорош, если важна чистая JSON Schema | нет причин |

Независимая проверка по сгенерированной схеме делается через **Ajv 8** (`ajv/dist/2020`) в контрактных тестах. Это ловит ошибки конвертации zod → JSON Schema.

Совместимость вперёд:
- **публикуемая** схема допускает неизвестные поля, объекты `additionalProperties` не закрываются;
- внутренние тесты используют строгий вариант, чтобы ловить случайно добавленные поля;
- в README закреплено правило: «потребитель игнорирует неизвестные поля и неизвестные `evidence.type`».

### 3.2 Скелет отчёта (иллюстрация)

```jsonc
{
  "$schema": "https://<pages>/schemas/report/1.0.0.json",
  "schemaVersion": "1.0.0",
  "tool": { "name": "dsgvo-check", "version": "1.2.3" },
  "scan": { "target": "https://example.de/", "startedAt": "…", "durationMs": 0,
            "userAgent": "…", "browser": { "name": "chromium", "version": "156…", "sandbox": true },
            "egress": { "proxy": false, "country": "DE?" }, "options": { "failOn": "critical", "lang": "de" } },
  "summary": { "critical": 2, "warning": 5, "info": 1, "suppressed": 1, "checkErrors": 0,
               "thresholdExceeded": true, "exitCode": 1 },
  "findings": [{
    "id": "EMBED-01", "fingerprint": "sha256:4f1c…", "severity": "critical", "crmCode": "T1_FONTS_EXTERNAL",
    "module": "browser", "phase": "preConsent", "page": "https://example.de/kontakt",
    "messageId": "EMBED-01", "params": { "host": "fonts.gstatic.com" },
    "title": "…", "summary": "…",                       // уже отрендерено на scan.options.lang
    "evidence": [{ "type": "request", "url": "https://fonts.gstatic.com/s/…", "method": "GET",
                   "resourceType": "font", "serverAddr": "142.250.…" }]
  }],
  "checks": [{ "id": "EMBED-01", "status": "fail", "durationMs": 3 }, { "id": "MAIL-03", "status": "error", "error": "…" }],
  "disclaimer": { "messageId": "report.disclaimer", "text": "…" }
}
```

- `evidence.type` — открытое перечисление: `request | cookie | header | dns | tls | file | dom | screenshot`. Покрывает требование ТЗ «URL, запрос, cookie, заголовок, DNS-запись».
- `severity` — закрытое: `critical | warning | info`.
- `checks[].status`: `pass | fail | error | skipped | not_applicable`.

### 3.3 Версионирование `schemaVersion`

| Изменение | Версия |
|---|---|
| Новое необязательное поле; новый ID проверки; новый `evidence.type`; новое значение `phase` | minor |
| Уточнение описаний, примеров | patch |
| Удаление или переименование поля, смена типа, новое значение у **закрытого** enum (`severity`), смена семантики `exitCode` или порога | major |
| Смена маппинга `crmCode` | ⚠ решить с заказчиком (предлагаю minor с пометкой в CHANGELOG, если CRM-импорт переживёт это) |

Схема публикуется в npm-пакете (`exports["./schema/report.json"]`) и на GitHub Pages. Неизменяемые копии лежат по точной версии (`/schemas/report/1.0.0.json`), алиас по major — `/v1.json`.

### 3.4 Стабильные ID

- ID проверок из каталога (`CONSENT-01` …) — публичный контракт. Они никогда не переиспользуются.
- Если проверку делим на части, заводим новый ID, а старой ставим `deprecated: true, replacedBy: [...]`.
- Находка идентифицируется связкой ID и fingerprint.

### 3.5 Fingerprint и baseline/suppress

- `fingerprint = "sha256:" + hex(sha256(JCS({ checkId, scope, key })))`, где JCS — каноническая сериализация JSON по RFC 8785.
  - `scope` — регистрируемый домен цели (eTLD+1 по `tldts`, MIT). Добавляется origin, если сканируется поддомен.
  - `key` — то, что вернул `fingerprintKey` проверки. Для EMBED-01 это eTLD+1 стороннего хоста, для HDR-01 — имя заголовка, для MAIL-01 — домен, для LEGAL-01 — тип документа.
- **Не входят** в fingerprint: query-строки, значения cookies, время, порядок страниц, полный URL страницы для находок уровня всего сайта.
- Suppress-файл `.dsgvo-check/suppressions.yaml`. В записи `id` или `fingerprint`, обязательные `reason` и `expires` (ISO-дата), опционально `owner`.
  - Просроченная запись снова считается в пороге и даёт warning в выводе.
  - `dsgvo-check baseline create` пишет текущие fingerprints. `--baseline <file>` учитывает в пороге только новые находки.
- Тот же fingerprint без изменений идёт в `partialFingerprints.primaryLocationLineHash` у SARIF и в `fingerprint` у GitLab CQ, если эти форматы появятся.

### 3.6 Форматы вывода: что в MVP

| Формат | MVP? | Обоснование |
|---|---|---|
| JSON | **P0** | контракт ТЗ |
| Консоль | **P0** | контракт ТЗ. Строки с сайтов санитизируются (§6.7) |
| GitHub Job Summary (Markdown) | **P0 (этап 2)** | дёшево и сразу видно в PR. Экранирование Markdown и HTML, без картинок |
| HTML | **P1** («если успеешь») | один файл, без JS (§6.7) |
| JUnit XML | **P1** | GitLab показывает тестовые отчёты в MR-виджете на Free. Модель простая: проверка = testcase, находка = failure. Путь к файлу не нужен |
| PDF | P1/P2 | `page.pdf()` из того же HTML, сеть офлайн |
| SARIF 2.1.0 | **P2** | GitHub требует «at least one location» с `physicalLocation.artifactLocation.uri` и `region.startLine`. Для сайта это фикция: пришлось бы привязывать находку к workflow-файлу или конфигу. Для приватных репозиториев нужна платная Code Security ⚠. Лимит 10 МБ gzip, 5000 показываемых результатов |
| GitLab Code Quality | **P2** | обязательны `location.path` и `location.lines.begin`, та же фикция. Отчёт в MR виден на Free, в пайплайне — на Premium+. Шаблон CodeClimate устарел в 17.3, удаление запланировано в 19.0 (импорт своего отчёта по-прежнему поддерживается) |

### 3.7 Exit-коды

| Ситуация | Код |
|---|---|
| Порог не превышен, ошибок проверок нет | 0 |
| Порог превышен: есть неподавленные находки ≥ `--fail-on`, даже если отдельные проверки упали | 1 |
| Порог не превышен, но хотя бы одна проверка в статусе `error`. Принцип: **«никогда не зелёный, если не всё проверено»**. Отключается `--check-errors=warn` | 2 |
| Фатальная ошибка: неверный конфиг или URL, цель недоступна, браузер не стартовал или не установлен, внутренний сбой, unhandled rejection | 2 |

`info` порог никогда не роняет. При `--fail-on warning` считаются `warning` и `critical`.

---

## 4. CI-интеграция

### 4.1 GitHub Action: варианты

| Критерий | Docker-action (`runs.using: docker`, `image: docker://ghcr…`) | **Composite + `docker run`** | Composite + `npx` + `playwright install` | JS-action (`node24`) |
|---|---|---|---|---|
| ОС раннера | только Linux (документация GitHub) | только Linux (нужен Docker) | Linux, macOS, Windows | Linux, macOS, Windows |
| Пользователь в контейнере | **root обязателен**: «Docker actions must be run by the default Docker user (root)», значит sandbox Chromium выключен | любой (`--user`) | пользователь раннера | пользователь раннера |
| Флаги изоляции (seccomp, cap-drop, mem/pids, read-only) | нет контроля | **полный контроль** | нет | нет |
| Что попадает внутрь | env, который раннер прокидывает сам (`GITHUB_*`, `RUNNER_*`; служебные `ACTIONS_RUNTIME_*`, скорее всего, тоже ⚠), смонтированный workspace | только то, что передали через `-e`/`-v` | всё окружение job'а | всё окружение job'а; браузеру можно дать очищенный `env` |
| Время старта | pull образа (~0.3–1 ГБ) | то же | установка Chromium с `--with-deps`, порядка минуты ⚠. Кэшировать браузеры Playwright не советует: восстановление из кэша занимает столько же, сколько загрузка | то же плюс бандл в `dist/`, закоммиченный в git |
| Воспроизводимость | digest | digest | `npx pkg@x.y.z` плюс версия браузера | бандл |
| Сопровождение | низкое | низкое | низкое | высокое: закоммиченный бандл тяжело ревьюить |

**Рекомендация:** composite-action в корне основного репозитория (Marketplace требует один `action.yml` в корне публичного репозитория).
- Режим по умолчанию `docker` для Linux.
- Режим `node` (npx, системный Chrome через `channel: 'chrome'` или `playwright install`) — запасной путь для macOS, Windows и раннеров без Docker. Добавляем после MVP.

Набросок (иллюстрация):

```yaml
inputs:
  url:      { required: true }
  fail-on:  { default: critical }
  network:  { default: bridge }        # 'host' — чтобы сканировать сервис, поднятый в том же job
outputs:
  exit-code: { value: ${{ steps.scan.outputs.exit-code }} }
runs:
  using: composite
  steps:
    - id: scan
      shell: bash
      env:                              # inputs только через env: никакого ${{ inputs.* }} внутри run (инъекция в shell)
        URL: ${{ inputs.url }}
        FAIL_ON: ${{ inputs.fail-on }}
        NET: ${{ inputs.network }}
        IMAGE: ghcr.io/OWNER/dsgvo-check@sha256:…   # бампается релизом (release-please extra-files)
      run: |
        out="$RUNNER_TEMP/dsgvo-check"; mkdir -p "$out"
        set +e
        docker run --rm --init --network "$NET" --user "$(id -u):$(id -g)" \
          --cap-drop=ALL --security-opt=no-new-privileges \
          --security-opt "seccomp=$GITHUB_ACTION_PATH/action/seccomp.json" \
          --read-only --tmpfs /tmp --tmpfs /home/scanner:uid=$(id -u) -e HOME=/home/scanner \
          --shm-size=1g --memory=3g --pids-limit=1024 \
          -v "$out:/out" "$IMAGE" "$URL" --fail-on "$FAIL_ON" --out /out --format json,html,junit,gh-summary
        code=$?; echo "exit-code=$code" >> "$GITHUB_OUTPUT"
        cat "$out/summary.md" >> "$GITHUB_STEP_SUMMARY"
        exit $code
```

Дальше идёт шаг `actions/upload-artifact`, закреплённый по SHA, с `retention-days`. Его включает input `upload-artifact: true`.

Почему `--user "$(id -u)"`: иначе контейнер не сможет писать в `/out`, который принадлежит пользователю раннера. Почему `--shm-size` вместо рекомендованного Playwright `--ipc=host`: `--ipc=host` отдаёт контейнеру IPC-неймспейс хоста, а для недоверенных сайтов это лишнее.

Альтернатива без Action, которую стоит описать в README: `jobs.scan.container: ghcr.io/OWNER/dsgvo-check:1.2.3` и `run: dsgvo-check "$URL"`.

### 4.2 GitLab

| Механизм | Плюсы | Минусы |
|---|---|---|
| **CI/CD Catalog component** (`include: component: gitlab.com/<group>/dsgvo-check/dsgvo-check@1.2.3`) | типизированные `spec:inputs`, находимость, semver, `~latest` и частичные версии | **только тот же инстанс**: «You can only reference components in the same GitLab instance». Для self-managed нужно зеркало, а это Premium/Ultimate. Релиз только через keyword `release` в CI-job'е. Проект живёт на gitlab.com |
| `include: remote:` + `integrity: sha256-…` (GitLab ≥17.9) | работает в любом инстансе, содержимое закреплено хешем | нет типизированных inputs у шаблона (впрочем, `spec:inputs` работают и в обычных include, ⚠ проверить для remote) |
| `include: project:` (свой форк или копия) | для закрытых сетей | ручная синхронизация |

**Рекомендация:**
- компонент на gitlab.com в отдельном проекте, `templates/` синхронизирует наш release-workflow с GitHub (deploy-токен в environment `release` с обязательными ревьюерами);
- в README пример `include:remote` + `integrity` для self-managed.

Детали шаблона:
- `image: { name: ghcr.io/…:1.2.3, entrypoint: [""] }`. Иначе ENTRYPOINT образа помешает выполнить `script`.
- `artifacts: { when: always, paths: [report/], reports: { junit: report/junit.xml }, expire_in: … }`.
- Input `allow-failure` превращается в `allow_failure: { exit_codes: [1] }` для «мягкого» режима.

Ограничение GitLab: проектные CI/CD-переменные (включая masked) видны всем job'ам, кроме защищённых и привязанных к environment. Вычистить их из конкретного job'а нельзя: `inherit:variables` действует только на YAML-переменные. Поэтому в документации пишем: секреты деплоя привязывать к environment и protected-веткам, а job сканера держать без environment.

Sandbox на shared-раннерах обычно недоступен: seccomp-опции задаёт администратор раннера в `config.toml`. Отсюда фолбэк в §6.2.

### 4.3 Docker-образ

| Вариант базы | Сжатый размер | Плюсы | Минусы |
|---|---|---|---|
| `mcr.microsoft.com/playwright:v1.64.1-noble` | ~984 МБ (amd64) | ноль усилий, проверенные зависимости, multi-arch | все браузеры (≈1 ГБ на каждый pull), root по умолчанию |
| **`node:24-<debian>-slim` + `playwright-core install --with-deps --only-shell chromium`** | ~300–450 МБ ⚠ | только нужное, свой пользователь, контролируемые шрифты | свои системные зависимости. Поддерживает ли `--with-deps` Debian 13 (trixie), проверить ⚠; Debian 12 (bookworm) поддерживается |
| то же, но полный Chromium из CfT (`--no-shell`, `channel: 'chromium'`, new headless) | +~75 МБ к архиву браузера | **«настоящий Chrome»**: выше достоверность поведения сайтов и CMP | больше размер |

Решение headless shell или new headless — открытый вопрос: замерить расхождения на 10 сайтах заказчика.

Требования к образу:
- пользователь `scanner` (uid 10001), `HOME` можно писать через tmpfs;
- `ENTRYPOINT ["dsgvo-check"]` плюс `/bin/sh` для GitLab;
- `tini` или `--init`;
- `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`;
- шрифты с умлаутами для скриншотов и PDF;
- OCI-лейблы (`org.opencontainers.image.source/version/revision/licenses`);
- seccomp-профиль кладём в образ (`/etc/dsgvo-check/seccomp.json`) и в Action.

Сборка и публикация:
- multi-arch amd64/arm64, нативно на `ubuntu-24.04` и `ubuntu-24.04-arm` (arm64-раннеры бесплатны для публичных репозиториев с августа 2025), затем объединение манифестов;
- QEMU для сборки с Chromium медленный;
- реестр **GHCR**, теги `1.2.3`, `1.2`, `1`. `latest` в документации не используем, советуем пин по digest.

Еженедельная пересборка ради патчей ОС и Chromium: только плавающие теги плюс тег с датой (`1.2.3-20261106`). Исходный `1.2.3` не перезаписываем ⚠ (открытый вопрос).

### 4.4 npm-пакет и установка браузера

| Способ | Вердикт |
|---|---|
| `postinstall`, скачивающий Chromium | **нет**. В pnpm 11 `strictDepBuilds=true`, так что непроверенный build-скрипт зависимости ломает установку. `--ignore-scripts` в CI — норма. Побочные сетевые эффекты при установке и риск для цепочки поставок |
| **Явная команда `dsgvo-check install [--with-deps]`** (обёртка над CLI `playwright-core` с той же версией) | **да** |
| Ленивая загрузка при первом запуске | только в TTY с вопросом y/N. В CI (не TTY) выдаём exit 2 и готовую команду |
| Системный Chrome (`--browser-channel chrome`) | опция. На GitHub-hosted Ubuntu Chrome предустановлен ⚠. Версия плавает, поэтому пишем её в отчёт |

Зависимость — `playwright-core` с точным пином. Пакет `playwright` не нужен: CLI тест-раннера нам ни к чему. Версия синхронизирована с образом, браузер привязан к ревизии в `browsers.json` (сейчас 1248). Пакет ESM-only, это допустимо, потому что в Node ≥22 работает `require(esm)`. В `exports` три точки: `.` (API), `./schema/*`, `./plugin` (типы, позже). Сборка — `tsc` из TS 7 с `isolatedDeclarations`. Перед публикацией в CI гоняем `publint` и `@arethetypeswrong/cli`. Полноту emit `.d.ts` в TS 7 проверить ⚠, запасной вариант — tsdown.

### 4.5 Пример «красной» сборки (этап 2)

Репозиторий `dsgvo-check-example`:
- `site/`: статичная страница с `fonts.googleapis.com`, заглушкой GA, ссылкой `href="#"` вместо Impressum, баннером без отказа;
- workflow поднимает `python3 -m http.server` и вызывает Action с `network: host` и `--only CONSENT-*,EMBED-*,LEGAL-*`, чтобы падение было «про DSGVO», а не про отсутствие TLS на localhost;
- вторая job сканирует ту же страницу на GitHub Pages (реальный HTTPS и настоящие сторонние запросы);
- PR «fix: self-host fonts» показывает переход из красного в зелёный, бейдж в README;
- аналогичный GitLab-проект с компонентом.

### 4.6 CI самого проекта

| Workflow | Триггер | Состав |
|---|---|---|
| `ci.yml` | PR, push | L0 и L1 на матрице Node 22/24/26 (ubuntu), L1 дополнительно на windows-latest и macos-latest (пути, CLI); L2 в Docker `--network none`; сборка образа amd64 без push; L3: CLI в образе (коды 0/1/2) и `uses: ./` с `continue-on-error` и проверкой `steps.scan.outputs.exit-code == '1'`; линт workflow (actionlint, zizmor ⚠ лицензия/версия) |
| `release.yml` | release-please | npm publish (OIDC), multi-arch образ, attest/SBOM, синхронизация GitLab-компонента, перенос тега `v1` |
| `nightly.yml` | cron | L2 с перемешиванием и повторами для поиска флейков, пересборка образа, Trivy или Grype по образу ⚠ выбрать |
| `scorecard.yml`, `codeql.yml` | cron, push | OpenSSF Scorecard v2.5.0, CodeQL JS/TS |

Гигиена workflow:
- `permissions: {}` на верхнем уровне, права выдаются по job'ам;
- все `uses:` закреплены по SHA (Renovate обновляет);
- `actions/checkout` с `persist-credentials: false`;
- без `pull_request_target`;
- `concurrency` на PR.

---

## 5. Релизы и цепочка поставок

### 5.1 release-please или changesets

| | release-please v5 | changesets 3 |
|---|---|---|
| Модель | conventional commits → Release PR → тег и GitHub Release | файлы `.changeset/*.md` в PR → Release PR |
| Один пакет | идеально | избыточно |
| Обновление версий в не-JSON файлах (`action.yml`, шаблон GitLab, README) | `extra-files` с аннотацией `x-release-please-version` | нужен свой скрипт |
| Человеческие release notes от внешних контрибьюторов | слабее (пишутся по коммитам) | сильнее |
| **Вердикт** | **да** | понадобится при переходе на монорепо с несколькими публикуемыми пакетами |

Нужна проверка заголовка PR на conventional commits и squash-merge. Как совместить «immutable releases» GitHub (GA с 2025-10-28: теги и ассеты релиза нельзя менять) с подгрузкой ассетов в уже созданный релиз (draft → publish), проверить ⚠. Плавающий тег `v1` к релизу не привязан и остаётся перемещаемым.

### 5.2 npm

- **Trusted Publishing (OIDC)** из GitHub Actions на GitHub-hosted раннерах: нужны npm CLI ≥11.5.1 и Node ≥22.14, `permissions: id-token: write`. Для публичного репозитория и пакета provenance генерируется **автоматически**. Self-hosted раннеры не поддерживаются.
- После настройки включить «Require two-factor authentication and disallow tokens». Классические токены отключены с ноября 2025, у write-granular токенов срок максимум 90 дней.
- **Staged publishing** (GA в мае 2026): trusted publisher в режиме stage-only публикует в очередь, а мейнтейнер подтверждает `npm stage approve` с 2FA. OIDC подтверждать не может, и в этом смысл. Ограничение: **первую** публикацию нового пакета поставить в стейдж нельзя.
- Публикуем через `npm publish`, а не `pnpm publish`. Поддержку OIDC в pnpm подтвердить не удалось ⚠. Pnpm 12 упоминает только `pnpm stage approve`.

### 5.3 Docker-образ

- BuildKit-аттестации `--sbom=true --provenance=mode=max` при сборке.
- **`actions/attest@v4`** с `push-to-registry: true`: SLSA provenance в GHCR, проверяется через `gh attestation verify oci://…`. Права: `id-token`, `attestations`, `artifact-metadata: write`, `packages: write`. Бесплатно для публичных репозиториев.
- Если нужна независимость от GitHub, альтернатива — keyless `cosign sign` v3 (формат bundle, Rekor v2).
- Composite Action может проверять аттестацию образа перед `docker run`: `gh` есть на hosted-раннерах. Это опция, стоит она несколько секунд ⚠.

### 5.4 SBOM

- Пакет: `pnpm sbom --sbom-format cyclonedx` (CycloneDX 1.7, также SPDX 2.3; с какой версии pnpm появилась команда, проверить ⚠). Запасной вариант — `@cyclonedx/cdxgen` (Apache-2.0).
- Образ: SBOM от BuildKit.
- Оба файла прикладываются к GitHub Release и аттестуются (`actions/attest` с `sbom-path`).

### 5.5 Обновления зависимостей

| | Renovate (Mend app, бесплатно для OSS) | Dependabot |
|---|---|---|
| Связать «`playwright-core` (npm) + `ARG PLAYWRIGHT_VERSION` в Dockerfile + digest базового образа» в один PR | `customManagers` (regex) и `groupName` | multi-ecosystem groups есть, но regex по произвольным файлам нет |
| Минимальный возраст релиза | `minimumReleaseAge` | `cooldown` (1–90 дней, только для version updates) |
| Пин actions и Docker по digest | пресет `config:best-practices` | частично |
| **Вердикт** | **да** | годится, если сторонние приложения запрещены политикой |

Политика:
- `minimumReleaseAge` ≥ 1 день, согласован с дефолтом pnpm 11. Иначе Renovate предложит версию, которую pnpm откажется ставить.
- Security-обновления и патчи Playwright/Chromium идут без задержки, с automerge после зелёного L2/L3: устаревший Chromium при сканировании недоверенных сайтов — прямой риск.

### 5.6 OpenSSF Scorecard и прочее

Целимся в ≥8/10:
- Pinned-Dependencies;
- Token-Permissions;
- Signed-Releases (provenance и аттестации);
- Branch-Protection и rulesets;
- Code-Review;
- SAST (CodeQL);
- Dependency-Update-Tool;
- Security-Policy (`SECURITY.md` и приватное сообщение об уязвимостях);
- License;
- CII Best Practices badge.

Минимум runtime-зависимостей, ориентир ≤8 прямых: `playwright-core`, `commander`, `zod`, `tldts`, `intl-messageformat`, `preact` и `preact-render-to-string`, `undici` (встроен в Node, но API Agent/lookup удобнее из пакета ⚠). В дереве зависимостей не должно быть install-скриптов, это гарантирует `strictDepBuilds`.

---

## 6. Безопасность самого сканера

### 6.1 Модель угроз

| Угроза | Вектор | Меры | Приоритет |
|---|---|---|---|
| RCE в рендерере (n-day) с выходом из него | Chromium **без sandbox** (дефолт Playwright `chromiumSandbox: false`), root в контейнере | `chromiumSandbox: true`, не root, seccomp-профиль с `clone/setns/unshare` (как в документации Playwright). Быстрые обновления Playwright и Chromium, еженедельная пересборка | P0 |
| Утечка секретов CI | env процессов, смонтированный workspace, токены раннера, `docker.sock` | отдельный job без секретов, `permissions: {}`. Браузер запускается с минимальным `env` (опция `launch({ env })`). В контейнер монтируется только `/out`, `docker.sock` — никогда | P0 |
| SSRF во внутреннюю сеть | JS страницы, редиректы и `<img>` на 10.0.0.0/8, 169.254.169.254, `[fd00:ec2::254]`; DNS-rebinding | блокируем private, loopback, link-local и metadata-адреса, **если сама цель публичная**. MVP: `route` и резолв в Node (возможна гонка между проверкой и использованием). P1: локальный фильтрующий прокси, который резолвит и соединяется сам. IMDSv2 на self-hosted | P0/P1 |
| Скачанные файлы | `acceptDownloads` по умолчанию `true` | `acceptDownloads: false`, read-only ФС | P0 |
| Исчерпание ресурсов | бесконечные редиректы, гигантские страницы, попапы, майнеры | таймауты на страницу и на весь скан, `--max-pages`, лимит запросов и размера тел (только first-party HTML/JS для VULN, ≤5 МБ), закрытие попапов, `--memory`, `--pids-limit`, убийство дерева процессов | P0 |
| XSS и утечки при открытии отчёта | строки с сайтов в HTML | §6.7 | P0 |
| Инъекции в лог и терминал | ANSI-последовательности, bidi-override, `::workflow-command::`, инъекция разделителя в `$GITHUB_OUTPUT` | §6.7 | P0 |
| Хранение чужих секретов | тела `.env` и `.git/config` (FILE-01), значения cookies | §6.8 | P0 |
| Вред сканируемому сайту и претензии | агрессивный обход | §6.6, только пассивные проверки (ТЗ) | P0 |
| Вредоносный плагин | внешние плагины | только явное подключение, без автозагрузки, предупреждение в выводе | P2 |

### 6.2 Профиль браузера (иллюстрация, не финальные значения)

- `launch`:
  - `chromiumSandbox: true`. Если sandbox не стартовал, по умолчанию **фолбэк** с громким предупреждением и `scan.browser.sandbox=false` в отчёте. Флаг `--require-sandbox` включает строгий режим.
  - Отказ по умолчанию сломал бы GitLab shared runners и `docker run` без seccomp. Будет ли sandbox работать в контейнере на хостах Ubuntu 24.04, где AppArmor ограничивает непривилегированные user namespaces, надо проверить ⚠.
  - `env` минимальный: `HOME`, `TMPDIR`, `LANG`, `TZ`.
  - Аргумент `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`: без него WebRTC отдаёт сайту внутренние IP раннера ⚠ проверить актуальность флага.
- `newContext` на каждый скан, «первый визит», без персистентного профиля:
  - `acceptDownloads: false`, `permissions: []`, `bypassCSP: false`;
  - `locale: 'de-DE'`, `timezoneId: 'Europe/Berlin'`, viewport как у десктопа;
  - `serviceWorkers: 'allow'` ради достоверности. События SW-запросов на уровне контекста в Chromium нужно проверить ⚠;
  - `userAgent`: UA обычного Chrome той же версии плюс ` dsgvo-check/1.2.3 (+https://github.com/OWNER/dsgvo-check)`.
- Защита от «браузерных» рисков Local Network Access в headless при автоматизации не документирована ⚠, поэтому на неё не полагаемся.

### 6.3 Запуск в контейнере

`--init --user <non-root> --cap-drop=ALL --security-opt=no-new-privileges --security-opt seccomp=<profile> --read-only --tmpfs /tmp --tmpfs $HOME --shm-size=1g --memory=3g --pids-limit=1024`, монтируется только выходная папка.

`no-new-privileges` ломает только SUID-sandbox Chromium. Sandbox на user namespaces с ним работает: так его и запускает seccomp-профиль Playwright.

### 6.4 Разделение секретов в CI

- **GitHub**: сканер — отдельный job с `permissions: { contents: read }` и без `secrets.*`. Загрузка результатов, комментарий в PR и SARIF (если он появится) идут во втором job'е, который принимает артефакт. PR из форков секретов и так не получают; `pull_request_target` не использовать.
- **GitLab**: см. §4.2. Секреты деплоя привязываются к environment и protected-веткам.

### 6.5 Сеть и SSRF (детали)

- Политика: если цель резолвится в публичный адрес, запросы в private, loopback и link-local сети блокируются и попадают в отчёт как `info` «blocked request to private network». Если сама цель приватная (localhost в примере, стенд в VPN), private разрешён.
- MVP: на уровне контекста `route('**')` резолвит хост через тот же `Resolver`, проверяет IP и делает `continue` или `abort`. Ограничение: Chromium резолвит повторно (окно для DNS-rebinding, гонка между проверкой и использованием).
- P1: Playwright `proxy` на встроенный CONNECT-прокси, который резолвит один раз и соединяется по полученному IP. Попутно он даёт точный удалённый IP для «Drittland»-доказательств и единую точку для rate limit.

### 6.6 Темп, User-Agent и bot-детект

- Честный UA в ТЗ обязателен. Но в нём **не должно быть** `bot`, `crawler`, `spider`, `Headless`: CMP и сайты показывают таким агентам другое поведение.
  - По заявлению Cookiebot, поисковые краулеры получают «полное согласие» и не видят баннер ⚠ (первоисточник отдал 403, факт взят из выдачи поиска).
  - Типовые CMP-регэкспы — `/bot|crawler|spider/i`.
  - UA headless shell содержит `HeadlessChrome`.
  - Значит, неправильный UA прямо даёт ложные CONSENT-01/03.
- Темп:
  - одна навигация за раз на хост;
  - HTTP-пробы (FILE-01, `security.txt`, `/wp-json/…`) не больше 2 параллельно, с паузой ≥250–500 мс;
  - верхний лимит числа проб;
  - `Retry-After` на 429/503 соблюдается;
  - `--max-pages` по умолчанию 10–20 ⚠ согласовать с LEGAL-01 («с каждой страницы»).
- **Выход в сеть из ЕС.** Регион GitHub-hosted раннеров выбрать нельзя (обсуждения в community, точных данных нет ⚠). Геотаргетированные CMP за пределами ЕС могут вообще не показать баннер. Что делаем:
  - опция `--proxy <url>` (Playwright `proxy`);
  - в отчёте `scan.egress`;
  - в README рекомендация: self-hosted раннер в ЕС или прокси для «доказательных» прогонов.

### 6.7 Отчёты как поверхность атаки

**HTML:**
- один самодостаточный файл **без JS**. Интерактивность через `<details>` и якоря. Это разом упрощает CSP, PDF и аудит;
- `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'sha256-…'; img-src data:; base-uri 'none'; form-action 'none'">` и `<meta name="referrer" content="no-referrer">`. Директивы `frame-ancestors` и `sandbox` в meta не работают, и для файла они не нужны;
- **никаких внешних ресурсов**: системный стек шрифтов, inline-SVG, скриншоты как `data:`. Ирония «отчёт DSGVO-тула тянет Google Fonts» закрыта тестом из §2.7;
- шаблонизатор с экранированием по умолчанию: Preact 11 и `preact-render-to-string` 6.8 (MIT). `dangerouslySetInnerHTML` запрещён правилом Biome `noDangerouslySetInnerHtml`;
- URL с сайтов выводятся **текстом** с кнопкой копирования, не кликабельными ссылками. Клик по трекерному URL из отчёта — это визит к трекеру. Если ссылки всё-таки нужны, то только `http:`/`https:` и `rel="noopener noreferrer nofollow"`;
- если когда-нибудь появится встроенный JSON, кладём его в `<script type="application/json">` и экранируем `<`, `>`, `&`, U+2028/2029.

**PDF:** `page.setContent(html)` + `page.pdf()` в отдельном контексте с `route('**', abort)` и `javaScriptEnabled: false`.

**Терминал и CI-логи:**
- из строк с сайтов вырезаем C0/C1-управляющие символы (кроме `\t`) и bidi-override (U+202A–202E, U+2066–2069);
- в GitHub Actions недоверенный вывод оборачиваем в `::stop-commands::<random>` … `::<random>::` ⚠ (не перепроверено в этой сессии);
- в `$GITHUB_OUTPUT` и `$GITHUB_ENV` пишем **только** значения, которые контролирует сам тул: коды, счётчики, пути;
- Job Summary: экранируем Markdown и HTML, без картинок.

**JUnit XML** собирается XML-построителем, недопустимые для XML символы вычищаются.

### 6.8 Редактирование данных

- **Cookies.** Хранятся имя, домен, путь, срок, флаги, SameSite, размер, partition, `valueSha256` (первые 12 hex) и длина. Сами значения только по флагу `--include-cookie-values`.
- **URL запросов.** Хост, путь и параметры из allowlist (`tid`, `id`, `v`, `en` …), чтобы ID счётчика вроде `G-XXXX` остался доказательством. Остальные значения маскируются, полный URL — по `--full-urls` ⚠ согласовать с заказчиком, достаточно ли этого как доказательства.
- **FILE-01.** `GET` с `Range: bytes=0-1023`. Сравниваем с откликом на случайный путь (защита от soft-404) и проверяем сигнатуру (`[core]` для `.git/config`, шаблон `KEY=` для `.env`). **Тело не сохраняется и не печатается**, в отчёт попадает только «доступно, сигнатура совпала».
- **Срок хранения.** Для артефактов в Action и шаблоне задаём `retention-days` и `expire_in`. Логи публичного репозитория публичны, отсюда приватная канарейка.

---

## 7. Локализация

| Формат | Плюсы | Минусы |
|---|---|---|
| Плоский JSON, `{placeholder}` | просто | нет комментариев, неудобно юристу, плюралы вручную |
| **YAML как источник + ICU MessageFormat 1** (`intl-messageformat`, BSD-3-Clause) | комментарии и многострочные тексты, удобно ревьюить, плюралы и select, поддержка в Weblate и Crowdin | в YAML строки, начинающиеся с `{`, нужно брать в кавычки (ловит линтер) |
| Unicode MessageFormat 2 (`messageformat@4`, Apache-2.0) | новый стандарт | меньше инструментов и переводческих платформ |
| Fluent | выразительный | ещё одна экосистема |
| Сообщения в папке каждой проверки | самодостаточная проверка | юристу придётся собирать тексты из 25+ мест |

**Рекомендация.**
- Тексты лежат в `data/messages/de.yaml` и `en.yaml`, по одному файлу на язык, в стиле ICU MF1. При сборке компилируются в JSON.
- Ключи: `<CHECK-ID>.title | summary | description | remediation`, плюс `report.disclaimer` и `report.notRecognizedBanner`.
- В текстах без Markdown: абзацы и отдельное поле `links: [{label, url}]`. Так в отчёт не тащится Markdown-рендерер, и меньше поверхность для XSS.
- `CODEOWNERS`: `de.yaml` ревьюит заказчик.
- Внешние плагины приносят свои каталоги, они сливаются с основным по префиксу ID.

Валидация на уровне L0:
- (1) набор ключей в `de` и `en` совпадает;
- (2) ICU-разметка парсится;
- (3) наборы плейсхолдеров в обоих языках одинаковы;
- (4) у каждой зарегистрированной проверки есть все ключи;
- (5) **фильтр формулировок для `de`**: список стоп-слов (например, `verstößt`, `rechtswidrig`, `illegal`, `Verstoß`, `unzulässig`) ведёт заказчик. Тест превращает ограничение ТЗ «без юридических выводов» в автоматическую проверку и требует явного allowlist-исключения;
- (6) лимит длины `summary` для консоли.

Язык по умолчанию `de` (целевая аудитория), выбирается через `--lang de|en`. В JSON всегда пишутся стабильные `messageId` и `params` для машин и рядом готовые `title`/`summary` на выбранном языке для людей.

---

## 8. Кандидаты в ADR

| Тема | Рекомендация | Уверенность |
|---|---|---|
| Runtime | Node 24 в образе и Action, CI 22/24/26, `engines >=22.12` | high |
| Язык и компилятор | TS 7.0 (`tsc` для typecheck и emit, `isolatedDeclarations`); TS 6.0.3 — запасной вариант, если понадобится typescript-eslint или TS API | medium |
| Пакетный менеджер | pnpm 11, пин через `packageManager`, `pnpm/action-setup`; на Corepack не опираемся | medium |
| Линт и формат | Biome 2.6 плюс oxlint-tsgolint (правила про промисы) | medium |
| Тесты | Vitest 5 (unit и integration), fixture-server, dns2, L2 в `--network none` | high |
| Архитектура | collectors → artifacts → pure checks → reporters, явный реестр с тестом полноты | high |
| Репозиторий | pnpm-workspace, один публикуемый пакет | medium |
| Схема | zod 4 → JSON Schema 2020-12 (закоммичена), Ajv в контрактных тестах, независимый semver | high |
| Fingerprint и suppress | sha256(JCS{checkId, scope, key}), `reason` и `expires` обязательны | high |
| Форматы | MVP: JSON, консоль, Job Summary; P1: HTML, JUnit; P2: SARIF, GitLab CQ, PDF | medium |
| GitHub Action | composite + `docker run` по digest с флагами изоляции | high |
| GitLab | Catalog component на gitlab.com + `include:remote`/`integrity` | high |
| Образ | свой `node:24-slim` + Chromium, multi-arch нативно, GHCR | medium |
| Браузер в npm | `dsgvo-check install`, без postinstall | high |
| Релизы | release-please v5, npm OIDC + staged publishing, `actions/attest`, SBOM, Renovate | high |
| Безопасность | sandbox включён с фолбэком и флагом, `acceptDownloads: false`, минимальный env, блок private-сетей, статичный отчёт с CSP, санитизация логов, редактирование cookies и FILE-01 | high |
| Достоверность | UA без bot/Headless, `de-DE`/`Europe/Berlin`, `--proxy`, `scan.egress` | high (риск), medium (решение) |
| Локализация | YAML + ICU MF1, один файл на язык, фильтр стоп-слов | medium |

---

## Источники

| URL | Что подтверждает |
|---|---|
| npm registry (`npm view <pkg> dist-tags time engines peerDependencies license`), 2026-10-30 | версии и даты: typescript 7.0.2/6.0.3, playwright 1.64.1, pnpm 12.16.1/11.28.9, vitest 5.0.5, eslint 10.13.0, @biomejs/biome 2.6.4, oxlint 1.90.0, tsup 9.0.0, tsdown 0.23.4, unbuild 3.6.1, zod 4.6.7, typebox 1.4.3, valibot 1.5.0, ajv 8.20.0, commander 15.0.0 (Node ≥22.12), release-please 17.11.2, @changesets/cli 3.0.3, dns2 3.1.1 (MIT), preact 11.1.0, preact-render-to-string 6.8.2. typescript-eslint 8.72.1 peer `typescript <6.1.0`. Пакет typescript@7.0.2 экспортирует только `./unstable/*`. Лицензии: @duckduckgo/autoconsent MPL-2.0, @ghostery/trackerdb CC-BY-NC-SA-4.0, intl-messageformat BSD-3-Clause, messageformat 4 (MF2) Apache-2.0 |
| https://nodejs.org/dist/index.json | v26.13.0 LTS «Lithium» (2026-10-28), v24.22.2 «Krypton» |
| https://raw.githubusercontent.com/nodejs/Release/main/schedule.json | даты LTS, Maintenance и EOL для 20/22/24/26 |
| https://github.com/nodejs/TSC/pull/1697 , https://github.com/nodejs/node/pull/61207 ; nodejs.org/api/corepack.html → 308 на github.com/nodejs/corepack | Corepack не распространяется вместе с Node начиная с 25 (часть данных видна только через зеркала ⚠) |
| https://playwright.dev/docs/api/class-browsertype | `chromiumSandbox` по умолчанию `false`; опция `env`; `channel: "chromium"` для new headless |
| https://playwright.dev/docs/api/class-browser | `acceptDownloads` по умолчанию `true` |
| https://playwright.dev/docs/docker | root по умолчанию отключает sandbox; для недоверенных сайтов отдельный пользователь и seccomp-профиль (`clone/setns/unshare`); `--init`, `--ipc=host`; теги noble, jammy, resolute |
| https://playwright.dev/docs/browsers , https://playwright.dev/docs/ci | headless shell и new headless; `--only-shell`; кэшировать браузеры не рекомендуется |
| https://playwright.dev/docs/release-notes | 1.64: Chromium 156.0.8078.4; 1.63: CfT на Linux arm64, прекращена поддержка Ubuntu 20.04; 1.62: прекращена поддержка Debian 11; 1.61: `apiResponse.securityDetails()/serverAddr()` |
| https://playwright.dev/docs/api/class-response | `securityDetails()` (issuer, protocol, validFrom/To), `serverAddr()` |
| https://mcr.microsoft.com/v2/playwright/manifests/v1.64.1-noble (+ блоб конфига) | multi-arch amd64/arm64; 983.9 и 958.2 МБ в сжатом виде; `NODE_VERSION=24`; `USER` не задан |
| https://hub.docker.com/v2/repositories/library/node/tags/24-trixie-slim | ≈83 МБ в сжатом виде |
| https://raw.githubusercontent.com/microsoft/playwright/v1.64.1/packages/playwright-core/browsers.json | chromium и chromium-headless-shell, ревизия 1248, «Chrome for Testing» |
| https://storage.googleapis.com/chrome-for-testing-public/156.0.8078.4/linux64/ (HEAD) | headless shell 125.8 МБ, полный chrome 200.3 МБ |
| https://docs.github.com/en/actions/reference/workflows-and-actions/dockerfile-support | Docker-actions обязаны работать от root, `USER` и `WORKDIR` не использовать |
| https://docs.github.com/en/actions/concepts/workflows-and-actions/custom-actions | Docker-actions только на Linux и медленнее JS-actions |
| https://github.blog/changelog/2026-09-23-deprecation-of-node-20-on-github-actions-runners/ | JS-actions на `node24`, Node 20 удалён 2026-09-23 |
| https://docs.github.com/en/actions/how-tos/create-and-publish-actions/publish-in-github-marketplace | один `action.yml` в корне, публичный репозиторий |
| https://github.blog/changelog/2025-10-28-immutable-releases-are-now-generally-available/ | immutable releases (GA) |
| https://github.blog/changelog/2025-08-07-arm64-hosted-runners-for-public-repositories-are-now-generally-available/ | arm64-раннеры для публичных репозиториев |
| https://docs.github.com/en/code-security/reference/code-scanning/sarif-support-for-code-scanning | SARIF 2.1.0; нужны location, `artifactLocation.uri` и `startLine`; лимиты; `primaryLocationLineHash` |
| https://docs.gitlab.com/ci/components/ | требования Catalog; компоненты только в пределах одного инстанса; зеркалирование на Premium/Ultimate; формы версий; публикация через keyword `release` |
| https://docs.gitlab.com/ci/yaml/#includeintegrity | `include:integrity` с GitLab 17.9, только для `remote` |
| https://docs.gitlab.com/ci/testing/code_quality/ | обязательные поля Code Quality; MR-виджет на Free; шаблон CodeClimate устарел в 17.3, удаление в 19.0 |
| https://docs.npmjs.com/trusted-publishers | провайдеры OIDC; npm ≥11.5.1, Node ≥22.14; автоматический provenance; self-hosted не поддерживаются; запрет токенов |
| https://github.blog/changelog/2026-05-22-staged-publishing-and-new-install-time-controls-for-npm | staged publishing, stage-only trusted publisher, подтверждение с 2FA |
| https://github.blog/changelog/2025-11-05-npm-security-update-classic-token-creation-disabled-and-granular-token-changes/ | отключение классических токенов, лимит 90 дней |
| https://pnpm.io/blog/releases/11.0 | `minimumReleaseAge` 1440, `strictDepBuilds` true, `blockExoticSubdeps` true, Node ≥22, `allowBuilds` |
| https://pnpm.io/blog/releases/12.0 | pnpm 12 переписан на Rust |
| https://pnpm.io/cli/sbom | `pnpm sbom`: CycloneDX 1.7 и SPDX 2.3 |
| https://biomejs.dev/linter/rules/no-floating-promises/ | правило в nursery |
| https://oxc.rs/docs/guide/usage/linter/type-aware.html | tsgolint на typescript-go, требует TS 7.0+, поддерживает `no-floating-promises` |
| https://www.infoq.com/news/2026/08/typescript-7-released/ ; https://visualstudiomagazine.com/articles/2026/06/22/typescript-7-0-rc-moves-microsofts-go-rewrite-into-the-mainline-compiler.aspx | TS 7: нет стабильного API до 7.1, новые дефолты из 6.0 (вторичные источники) |
| https://github.com/googleapis/release-please-action/releases | v5.0.0 (2026-04-22) |
| https://github.com/ossf/scorecard-action/releases | v2.5.0 |
| https://github.com/sigstore/cosign/releases | v3.1.4; формат bundle по умолчанию; Rekor v2 |
| https://github.com/actions/attest , https://github.com/actions/attest-build-provenance | `actions/attest@v4`, `push-to-registry`, нужные права; attest-build-provenance теперь обёртка над ним |
| https://github.com/GoogleChrome/lighthouse/blob/main/docs/architecture.md | модель gatherers → artifacts → audits, `--gather-mode` |
| https://chromium.googlesource.com/chromium/src/+/57d342625c/net/base/host_mapping_rules.cc | грамматика `MAP pattern replacement[:port]` (для `--host-rules`; для `--host-resolver-rules` проверить ⚠) |
| https://raw.githubusercontent.com/jkwakman/Open-Cookie-Database/master/LICENSE ; …/cavi-au/Consent-O-Matic/master/LICENSE ; …/duckduckgo/tracker-radar/main/LICENSE ; …/disconnectme/disconnect-tracking-protection/master/LICENSE | Apache-2.0; MIT; CC BY-NC-SA 4.0; CC BY-NC-SA 4.0 |
| `npm pack @duckduckgo/autoconsent@17.1.0` (содержимое тарбола) | правила для Borlabs, Cookiebot, Complianz, Usercentrics, CCM19, Real Cookie Banner, CookieHub |
| https://db-ip.com/db/download/ip-to-country-lite | CC BY 4.0, нужна атрибуция, обновление ежемесячно |
| https://support.cookiebot.com/hc/en-us/articles/360005114894 (403; цитата из поисковой выдачи) | краулеры получают симулированное «полное согласие» ⚠ |
| https://github.com/orgs/community/discussions/58739 и др. (community) | регион GitHub-hosted раннеров не выбирается ⚠ |
| https://docs.github.com/en/code-security/tutorials/secure-your-dependencies/optimizing-pr-creation-version-updates | Dependabot `cooldown` |

---

## Открытые вопросы

1. Где хостится основной репозиторий (предполагаю GitHub) и есть ли у заказчика группа на gitlab.com под Catalog-компонент? Нужна ли поддержка self-managed GitLab?
2. Headless shell или new headless (`channel: 'chromium'`, CfT)? Компромисс между достоверностью и размером образа. Предлагаю замерить расхождения на 10 сайтах заказчика на этапе 1.
3. Обязателен ли выход в сеть из ЕС для «доказательных» прогонов (геотаргетинг CMP)? Если да, то self-hosted раннер в ЕС, `--proxy` или пометка в отчёте.
4. Exit-код при ошибке отдельной проверки: подтверждает ли заказчик правило «никогда не зелёный, если не всё проверено» (код 2)?
5. Входит ли `crmCode` в публичный контракт схемы? Смена маппинга — это minor или major?
6. Язык по умолчанию для консоли и отчёта: всегда `de` или по `LANG`? Рендерить ли тексты в JSON или отдавать только `messageId` и `params`?
7. Канарейка:
   - нужно ли согласие владельцев 10 сайтов на ночное сканирование;
   - кто размечает `mustFind/mustNotFind`;
   - где хранятся отчёты (приватный репозиторий или зашифрованный артефакт).
8. Хватает ли для доказательной базы аудита хешей значений cookies и замаскированных query-параметров?
9. Лицензия немецких текстов находок и дисклеймера (Apache-2.0 как часть репозитория?) и процесс DCO/CLA для внешних контрибьюторов.
10. Нужен ли листинг в GitHub Marketplace (тогда `action.yml` в корне основного репозитория, как предложено, или отдельный репозиторий)?
11. Поддерживать ли npm-режим на Windows и macOS? От этого зависят матрица CI и приоритет режима `node` в Action.
12. Политика пересборки образа: перезаписывать ли `1.2.3` патчами ОС и Chromium или публиковать теги с датой?
13. Поведение sandbox по умолчанию: фолбэк с предупреждением (моё предложение) или отказ с ошибкой?
