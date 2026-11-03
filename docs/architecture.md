# Архитектура одним взглядом

`dsgvo-check` — пассивный CLI-сканер сайтов на TypeScript и Playwright: ищет признаки нарушений DSGVO/TDDDG/DDG и базовые проблемы безопасности, а по найденному роняет CI.

Конвейер: коллекторы (browser, http, tls, dns) → редактированный снимок → `derive` → проверки → `assess` → `gate` → репортёры (JSON, консоль, HTML, Summary, PDF). Коллекторы делают весь I/O и редактируют данные до записи: значений cookies, Web Storage и TC-String в снимке нет. `derive`, проверки, `assess` и `gate` — чистые функции, а уровни находок задают данные в `test/data`, не код проверок.

Код выхода: `0` — причин для отказа нет; `1` — достигнут порог `--fail-on` (по умолчанию `critical`); `2` — сбой скана или записи отчёта (приоритетнее `1`), ошибка значимой проверки либо сработал `--strict`.

Контракты, поток данных и обоснования решений — в [docs/02-architecture.md](02-architecture.md), правила для агентов — в [AGENTS.md](../AGENTS.md).

## Дерево репозитория

Комментарий стоит после `#`. Строка `… N файлов` сворачивает однотипные файлы каталога, `(N файлов)` в конце комментария заменяет каталог целиком. `schema/` создаёт `corepack pnpm build`, в git его нет. Данные пакета (ruleset, тексты, каталог сервисов, шаблон отчёта) лежат в `test/data/`, но входят в npm-пакет и в образ.

```text
dsgvo-check/                                   # корень репозитория
├── .github/                                   # CI самого проекта и скрипты проверки релиза
│   ├── scripts/                               # TS-логика шагов CI: версия, релиз, проверка CLI и Action
│   │   ├── release.ts                         # проверки релиза: версия, draft-данные, свободный тег; summary
│   │   ├── verify-action.ts                   # проверка результата Action: код, summary.md, HTML
│   │   ├── verify-cli.ts                      # упакованный CLI: --help, --version, отказ на ftp:// с кодом 2
│   │   └── version.ts                         # версия из package.json в вывод шага
│   └── workflows/                             # GitHub Actions проекта
│       ├── ci.yml                             # тесты и e2e на Node, образ, Action против образа
│       └── release.yml                        # ручной релиз: образ с тегом версии, тег v<версия>
├── canary/                                    # канарейка: измерение сканера на локальном корпусе
│   ├── README.md                              # правила, этика, запуск; какой трафик шлёт сканер
│   └── sites.example.yaml                     # пример корпуса: все поля схемы, вымышленные хосты
├── docker/                                    # файлы образа
│   ├── entrypoint.sh                          # точка входа: профиль seccomp или CLI под tini
│   ├── README.md                              # сборка, запуск с усиленной изоляцией, релизы образа
│   └── seccomp-chromium.json                  # профиль seccomp для песочницы Chromium
├── docs/                                      # документация проекта
│   ├── 01-research/                           # ресёрч, на котором стоят решения
│   │   ├── browser-automation.md              # Playwright: сеть, cookies, анти-бот, CMP, отчёт, Docker
│   │   ├── data-sources-and-licenses.md       # источники данных и их лицензии
│   │   ├── http-dns-tls-mail.md               # HTTP, TLS, DNS и почта на Node.js
│   │   ├── legal-basis-map.md                 # правовая карта проверок (черновик для ревью)
│   │   ├── prior-art.md                       # аналоги и чем проект отличается
│   │   └── regulatory-landscape-2026.md       # регуляторный ландшафт: TDDDG, DDG, DSGVO
│   ├── legal/                                 # правила формулировок
│   │   └── wording-guide.md                   # Formulierungsleitfaden: тексты, стоп-слова, дисклеймер
│   ├── prototype/                             # срез прототипа
│   │   └── BRIEF.md                           # объём прототипа, упрощения относительно 1.0, CLI
│   ├── 00-brief.md                            # бриф: что строим, для кого и зачем
│   ├── 02-architecture.md                     # контракты и слои целевой 1.0; пути прототипа отличаются
│   ├── 03-checks.md                           # спецификация проверок; таблица §2.1 генерируется
│   ├── 04-quality-and-delivery.md             # тесты L0-L4, CI, Action, GitLab, Docker, релизы
│   └── architecture.md                        # этот файл: архитектура одним взглядом
├── examples/                                  # примеры подключения
│   └── github-failing/                        # пример «красной» сборки GitHub
│       ├── .github/                           # workflow примера, не корневой
│       │   └── workflows/                     # GitHub Actions примера
│       │       └── dsgvo-check.yml            # публикация демо-страницы и скан Action-ом
│       ├── site/                              # демо-страница
│       │   └── index.html                     # демо-страница с двумя намеренными находками
│       └── README.md                          # что демонстрирует пример и как его запустить
├── schema/                                    # результат сборки, в git нет
│   └── report.schema.json                     # JSON Schema отчёта; пишет pnpm build из zod-схемы
├── scripts/                                   # скрипты разработки; сборке образа нужен только emit-schema.ts
│   ├── canary-aggregate.ts                    # агрегация в summary.json без имён сайтов
│   ├── canary-args.ts                         # аргументы командной строки раннера
│   ├── canary-load.ts                         # чтение каталога прогона, CMP по сохранённому снимку
│   ├── canary-markdown.ts                     # SUMMARY.md: сводка таблицами
│   ├── canary-results.ts                      # раскладка каталога прогона, атомарный JSON I/O
│   ├── canary-runner.ts                       # пул заданий, watchdog, возобновление, переанализ
│   ├── canary-scanners.ts                     # сканеры: в процессе через API или CLI-подпроцесс
│   ├── canary-sites.ts                        # схема и фильтры корпуса canary/sites.yaml
│   ├── canary.ts                              # точка входа: прогон и команда summary
│   ├── emit-registry.ts                       # таблица §2.1 в docs/03-checks.md из ruleset
│   └── emit-schema.ts                         # schema/report.schema.json из zod-схемы
├── specs/                                     # исходные требования заказчика
│   ├── dsgvo-check_idea.md                    # исходная идея и зафиксированные решения
│   ├── dsgvo-check_katalog-proverok.md        # каталог проверок из аудитов (P0, P1)
│   └── dsgvo-check_TZ.md                      # техническое задание
├── src/                                       # исходный код (TypeScript, собирается в dist/)
│   ├── checks/                                # проверки: чистые функции над срезом снимка, без I/O
│   │   ├── browser/                           # браузерные проверки (фазы A/B/C)
│   │   │   ├── consent-01.ts                  # сторонние запросы до взаимодействия с баннером
│   │   │   ├── consent-02.ts                  # cookies и Web Storage до взаимодействия
│   │   │   ├── consent-03.ts                  # баннер не найден при наблюдаемом трекинге
│   │   │   ├── consent-04.ts                  # первый слой баннера и работа отказа
│   │   │   ├── consent-05.ts                  # трекинг после подтверждённого отказа
│   │   │   ├── embed-01.ts                    # внешние шрифты до согласия или после отказа
│   │   │   ├── embed-02.ts                    # внешние карты до согласия или после отказа
│   │   │   ├── index.ts                       # реестр браузерных проверок
│   │   │   ├── legal-01.ts                    # Impressum и Datenschutzerklärung достижимы
│   │   │   ├── priv-01.ts                     # сервисы из каталога названы в Datenschutzerklärung
│   │   │   ├── shared.ts                      # общие чистые помощники: бот/гео-сигналы, evidence
│   │   │   └── track-01.ts                    # инвентарь аналитики, рекламы, записи сессий (info)
│   │   ├── dns/                               # проверки почтовых записей
│   │   │   ├── lib/                           # разбор записей; их же использует DNS-коллектор
│   │   │   │   ├── dmarc.ts                   # парсер DMARC и Tree Walk
│   │   │   │   ├── evidence.ts                # evidence типа dns из записанных запросов
│   │   │   │   ├── records.ts                 # общие помощники над записями DNS
│   │   │   │   └── spf.ts                     # парсер SPF и статический разбор дерева include
│   │   │   ├── index.ts                       # реестр DNS-проверок
│   │   │   ├── mail-01.ts                     # DMARC на хосте, матрица Null-MX
│   │   │   └── mail-02.ts                     # SPF почтового домена вместе с DMARC
│   │   ├── http/                              # проверки HTTP и TLS
│   │   │   ├── hdr-01.ts                      # заголовки безопасности основных документов
│   │   │   ├── index.ts                       # реестр HTTP/TLS-проверок
│   │   │   ├── shared.ts                      # общие чистые помощники проверок и коллектора
│   │   │   ├── tls-01.ts                      # ведёт ли http:// на https://
│   │   │   └── tls-02.ts                      # сертификат: срок, имя, цепочка
│   │   └── index.ts                           # явный реестр всех проверок; ядро их не импортирует
│   ├── cmp/                                   # подсистема CMP: распознавание баннера и клик по выбору core
│   │   ├── adapters/                          # адаптеры CMP: extract / act / verify, без решений
│   │   │   ├── base.ts                        # общая механика адаптеров
│   │   │   ├── borlabs.ts                     # Borlabs Cookie
│   │   │   ├── ccm19.ts                       # CCM19
│   │   │   ├── complianz.ts                   # Complianz
│   │   │   ├── cookiebot.ts                   # Cookiebot
│   │   │   ├── cookiehub.ts                   # CookieHub
│   │   │   ├── real-cookie-banner.ts          # Real Cookie Banner
│   │   │   └── usercentrics.ts                # Usercentrics v2 и v3
│   │   ├── page/                              # код, исполняемый внутри страницы
│   │   │   ├── detect.ts                      # признаки присутствия CMP и TCF ping
│   │   │   ├── dom.ts                         # минимальные типы DOM для кода внутри страницы
│   │   │   ├── measure.ts                     # сторона Node: замер первого слоя и блокировки
│   │   │   ├── probe-types.ts                 # аргументы и сырой результат замера
│   │   │   └── probe.ts                       # замер баннера внутри страницы, только чтение
│   │   ├── classify.ts                        # чистая таблица первого слоя: отказ, согласие, цель клика
│   │   ├── detection.ts                       # уверенность распознавания: high от 2 независимых признаков
│   │   ├── index.ts                           # вход: ожидание CMP, выбор адаптера, общая эвристика
│   │   ├── lexicon-file.ts                    # загрузка лексикона кнопок из test/data/cmp
│   │   ├── lexicon.ts                         # чистый лексикон кнопок: нормализация и классификация
│   │   └── types.ts                           # факты CMP и контракт адаптера
│   ├── collectors/                            # коллекторы: весь I/O; редактируют до записи в снимок
│   │   ├── browser/                           # Chromium: фазы A, B, C в свежем профиле
│   │   │   ├── challenge.ts                   # обнаружение WAF и бот-защиты на странице
│   │   │   ├── cmp-bridge.ts                  # мост к подсистеме CMP с таймаутами
│   │   │   ├── collector.ts                   # сбор по фазам A/B/C, фатальные условия старта
│   │   │   ├── config.ts                      # константы, тайминги, allowlist query
│   │   │   ├── consent-phase.ts               # фазы B и C: наблюдение, клик, проверка, reload
│   │   │   ├── documents.ts                   # текст Impressum и Datenschutzerklärung по разделам
│   │   │   ├── dom.ts                         # сырые факты DOM в редактированные DomFacts
│   │   │   ├── features.ts                    # безопасные признаки запросов до редактирования
│   │   │   ├── http-fetch.ts                  # GET для robots.txt и sitemap с учётом сети и SSRF
│   │   │   ├── in-page-document.ts            # в странице: текст юридического документа
│   │   │   ├── in-page-dom.ts                 # в странице: ссылки, формы, iframe
│   │   │   ├── in-page-input.ts               # в странице: доверенные нажатия
│   │   │   ├── in-page-storage.ts             # в странице: cookies и Web Storage без значений
│   │   │   ├── index.ts                       # вход браузерного коллектора
│   │   │   ├── jar.ts                         # cookies и Web Storage по фазам: имена, флаги, длины
│   │   │   ├── launch.ts                      # запуск Chromium: свежий профиль, песочница, de-DE
│   │   │   ├── legal-documents.ts             # очередь страниц юридических документов
│   │   │   ├── legal-lexicon-file.ts          # загрузка лексикона из test/data/legal
│   │   │   ├── legal-lexicon.ts               # чистый лексикон юридических ссылок
│   │   │   ├── navigate.ts                    # навигации с политикой перегрузки (429/503)
│   │   │   ├── pages.ts                       # выбор страниц и контрольных страниц для B/C
│   │   │   ├── phase-a.ts                     # фаза A: старт, юридические страницы, контакты
│   │   │   ├── quiet.ts                       # ожидание «тишины» вместо networkidle
│   │   │   ├── recorder.ts                    # запись запросов фазы в редактированном виде
│   │   │   ├── robots.ts                      # robots.txt (RFC 9309) и sitemap
│   │   │   ├── screenshot.ts                  # снимок области баннера до любого действия
│   │   │   ├── ssrf.ts                        # SSRF-граница браузера: приватные адреса (CDP Fetch)
│   │   │   ├── util.ts                        # мелкие асинхронные помощники
│   │   │   └── visit.ts                       # одна навигация: ожидание, ответ, DOM, challenge
│   │   ├── dns/                               # DNS для MAIL-01 и MAIL-02
│   │   │   ├── collect.ts                     # запросы MX, DMARC Tree Walk, SPF; бюджет 60 запросов
│   │   │   ├── index.ts                       # вход DNS-коллектора
│   │   │   └── resolver.ts                    # клиент node:dns, один повтор при SERVFAIL и TIMEOUT
│   │   ├── http/                              # HTTP-пробы класса T
│   │   │   ├── client.ts                      # вежливый клиент undici: до 2 запросов в секунду на хост
│   │   │   ├── hosts.ts                       # варианты хоста: целевой, www, apex
│   │   │   ├── html.ts                        # эвристики по префиксу HTML без выполнения страницы
│   │   │   └── index.ts                       # цепочки редиректов и заголовки основных документов
│   │   └── tls/                               # TLS-рукопожатия
│   │       ├── index.ts                       # по одному рукопожатию на вариант хоста
│   │       ├── probe.ts                       # рукопожатие node:tls и собственная проверка имени
│   │       └── tunnel.ts                      # HTTP CONNECT для --proxy
│   ├── core/                                  # ядро: контракты и чистая логика, проверок не знает
│   │   ├── api.ts                             # единственный модуль ядра, который импортируют проверки
│   │   ├── assess.ts                          # наблюдения в находки: ruleset, кэп confidence, routing
│   │   ├── check.ts                           # контракт проверки: defineCheck, Observation, CheckContext
│   │   ├── collector.ts                       # контракт коллектора
│   │   ├── data.ts                            # загрузчики test/data: ruleset, тексты, каталоги
│   │   ├── disclaimer.ts                      # дисклеймер с условными абзацами
│   │   ├── duration.ts                        # разбор --timeout (8m, 90s)
│   │   ├── email.ts                           # маскирование e-mail до домена
│   │   ├── errors.ts                          # причины фатального завершения (код выхода 2)
│   │   ├── execute.ts                         # запуск одной проверки по срезу, статусы при сбое сбора
│   │   ├── fingerprint.ts                     # устойчивый fingerprint находки (sha256 от JCS)
│   │   ├── gate.ts                            # код выхода 0/1/2 и exitReasons: чистая функция
│   │   ├── headers.ts                         # нормализация заголовков ответа для снимка
│   │   ├── logger.ts                          # логгер в stderr, без значений
│   │   ├── messages.ts                        # подмножество ICU MessageFormat для текстов
│   │   ├── net.ts                             # классы адресов для SSRF-границы, NetworkConfig
│   │   ├── redact.ts                          # редактирование свободного текста: mailto, адреса, TXT
│   │   ├── registry.ts                        # реестр проверок, список приходит снаружи
│   │   ├── report-schema.ts                   # zod-схема отчёта: единственный источник JSON Schema
│   │   ├── report.ts                          # сборка полного и минимального (failed) отчёта
│   │   ├── reporter.ts                        # контракт репортёра, форматы, имена файлов
│   │   ├── sanitize.ts                        # очистка внешних строк: ANSI, bidi, команды CI
│   │   ├── snapshot-browser.ts                # секция снимка: браузер
│   │   ├── snapshot-common.ts                 # общие типы секций: фазы, URL, заголовки
│   │   ├── snapshot-dns.ts                    # секция снимка: DNS
│   │   ├── snapshot-http.ts                   # секция снимка: HTTP
│   │   ├── snapshot-tls.ts                    # секция снимка: TLS
│   │   ├── snapshot.ts                        # Snapshot: корень, секции, срезы по requires
│   │   ├── url.ts                             # цель, санитизация URL, allowlist query, eTLD+1
│   │   ├── user-agent.ts                      # честный User-Agent со ссылкой на репозиторий
│   │   └── version.ts                         # имя и версия из package.json
│   ├── derive/                                # derive: чистая классификация фактов снимка
│   │   ├── catalog.ts                         # загрузка и компиляция каталога сервисов
│   │   ├── index.ts                           # сторонний ли хост, какой сервис, стадия, момент
│   │   └── types.ts                           # типы производной классификации
│   ├── reporters/                             # репортёры: Report в строку; запись файлов в write.ts
│   │   ├── console.ts                         # консольный отчёт
│   │   ├── disclaimer.ts                      # реэкспорт сборки дисклеймера из ядра
│   │   ├── html.ts                            # загрузка шаблона и хеш стилей для CSP
│   │   ├── json.ts                            # JSON-контракт; crmCode только здесь
│   │   ├── pdf.ts                             # печать готового HTML в PDF через Chromium
│   │   ├── report-view.ts                     # данные для шаблона: тексты и встроенные изображения
│   │   ├── summary.ts                         # Markdown для GitHub Job Summary
│   │   ├── template.ts                        # строгий язык HTML-шаблона, вывод всегда экранируется
│   │   └── write.ts                           # запись файлов отчётов; сбой записи даёт код 2
│   ├── cli.ts                                 # CLI на commander: скан, report, install; код выхода
│   ├── index.ts                               # программный API: scan, gate, схема (канарейка, тесты)
│   ├── scan-collect.ts                        # фаза сбора: коллекторы под общим дедлайном
│   ├── scan-options.ts                        # опции скана: умолчания, валидация
│   └── scan.ts                                # оркестратор: preflight, сбор, derive, проверки, assess, gate
├── templates/                                 # шаблоны для пользователей
│   └── gitlab/                                # шаблон для GitLab CI
│       └── dsgvo-check.gitlab-ci.yml          # шаблон GitLab CI (include:remote + integrity), тот же образ
├── test/                                      # тесты, данные пакета, фикстурный сервер
│   ├── data/                                  # данные пакета: идут в npm-пакет и образ, не только в тесты
│   │   ├── cmp/                               # лексикон кнопок CMP
│   │   │   └── lexicon.yaml                   # лексикон кнопок первого слоя (de, en и другие языки)
│   │   ├── legal/                             # лексикон юридических ссылок
│   │   │   └── links.yaml                     # подписи и пути ссылок на Impressum и Datenschutz
│   │   ├── report/                            # шаблон HTML-отчёта
│   │   │   └── report.html                    # шаблон отчёта: один файл, без JS и внешних ресурсов
│   │   ├── ruleset/                           # ruleset: варианты, уровни, gating, коды CRM
│   │   │   └── de-2026/                       # профиль de-2026
│   │   │       ├── _profile.yaml              # версия профиля, Rechtsstand, флаг draft
│   │   │       ├── browser.yaml               # варианты браузерных проверок
│   │   │       ├── dns.yaml                   # варианты проверок DNS
│   │   │       └── http.yaml                  # варианты проверок HTTP и TLS
│   │   ├── services/                          # собственный каталог сервисов (Apache-2.0)
│   │   │   ├── _catalog.yaml                  # формат записи, категории, allowlist
│   │   │   ├── ads.yaml                       # реклама
│   │   │   ├── analytics.yaml                 # аналитика, тег-менеджеры, запись сессий, мониторинг
│   │   │   ├── consent.yaml                   # CMP и провайдеры согласия
│   │   │   ├── embeds.yaml                    # шрифты, карты, видео, captcha
│   │   │   ├── infrastructure.yaml            # CDN и платёжные сервисы
│   │   │   └── widgets.yaml                   # соцсети, отзывы, чаты, виджеты
│   │   ├── texts/                             # все пользовательские строки; de и en
│   │   │   ├── de/                            # немецкие тексты, основной язык отчёта
│   │   │   │   ├── browser.yaml               # тексты находок браузерных проверок
│   │   │   │   ├── core.yaml                  # интерфейс CLI, дисклеймер, диагностики
│   │   │   │   ├── dns.yaml                   # тексты находок DNS
│   │   │   │   ├── http.yaml                  # тексты находок HTTP и TLS
│   │   │   │   └── report.yaml                # подписи HTML-отчёта и Summary
│   │   │   └── en/                            # зеркало de/ на английском (5 файлов)
│   │   └── routing.yaml                       # какая проверка владеет категорией сервиса
│   ├── e2e/                                   # L3: собранный CLI, образ, Action (только loopback)
│   │   ├── sites/                             # сайты для e2e
│   │   │   ├── clean/                         # чистый сайт (6 файлов)
│   │   │   └── tracker/                       # сайт с трекером до согласия (7 файлов)
│   │   ├── support/                           # обвязка e2e
│   │   │   ├── cli-harness.ts                 # сборка, стенд, фейковый DNS, запуск CLI
│   │   │   ├── dns-server.ts                  # фейковый DNS: DMARC, SPF, MX
│   │   │   └── network-hook.ts                # preload: сеть собранного CLI на стенд
│   │   ├── cli.e2e.test.ts                    # dist/cli.js: коды 0/1/2, отчёты, нет значений в выводе
│   │   ├── delivery-config.e2e.test.ts        # контракты поставки: изоляция, версии, артефакты
│   │   ├── docker.e2e.test.ts                 # образ и Action; только при DSGVO_E2E_IMAGE
│   │   ├── report.e2e.test.ts                 # команда report: HTML и PDF из JSON
│   │   └── traffic-docs.e2e.test.ts           # описанный в canary/README трафик равен реальным пробам
│   ├── fixture-server/                        # локальный сервер виртуальных хостов с настоящим TLS
│   │   ├── sites/                             # содержимое сайтов, руками, по модулям владельца
│   │   │   ├── browser/                       # cookies, шрифты, карты, выбор страниц, SSRF (60 файлов)
│   │   │   ├── cmp/                           # ручные стенды CMP: по адаптеру, общие, магазины (69 файлов)
│   │   │   ├── core/                          # smoke-сайт (3 файла)
│   │   │   └── pipeline/                      # сквозные: магазин с CMP, пассивность (24 файла)
│   │   ├── server.ts                          # HTTP и HTTPS на случайных портах, хост по Host и SNI
│   │   └── sites.ts                           # объявления сайтов: хосты, TLS, маршруты, заголовки
│   ├── fixtures/                              # фикстуры
│   │   ├── reports/                           # образцы отчётов
│   │   │   └── sample-full.report.json        # образец полного отчёта для тестов репортёров
│   │   └── snapshots/                         # фикстуры-файлы (остальные проверки строят снимки в памяти)
│   │       └── http/                          # снимки HTTP-проверок, по каталогу на проверку
│   │           ├── HDR-01/                    # violation, clean, inconclusive, контрпримеры (6 файлов)
│   │           ├── TLS-01/                    # violation, clean, inconclusive, контрпримеры (8 файлов)
│   │           └── TLS-02/                    # violation, clean, inconclusive, контрпримеры (11 файлов)
│   ├── integration/                           # L2: настоящий Chromium, undici, node:tls, dns2 на loopback
│   │   ├── browser/                           # браузерный коллектор на стендах: фазы, cookies, SSRF (35 файлов)
│   │   ├── cmp/                               # адаптеры CMP на стендах, замер первого слоя (15 файлов)
│   │   ├── core/                              # CLI из исходников и smoke сети стенда (2 файла)
│   │   ├── dns/                               # DNS-коллектор и скан против фейкового DNS (3 файла)
│   │   ├── http/                              # HTTP- и TLS-коллекторы, прокси, скан (8 файлов)
│   │   ├── pipeline/                          # сквозные сценарии: согласие, трекер, пассивность (2 файла)
│   │   └── reporters/                         # печать PDF (2 файла)
│   ├── live/                                  # живые сайты; не входит в pnpm test
│   │   └── smoke.test.ts                      # собранный CLI против реальных сайтов, по одному
│   ├── unit/                                  # L0-L1: без браузера и сети
│   │   ├── canary/                            # корпус, раннер и агрегация канарейки (5 файлов)
│   │   ├── checks/                            # проверки на срезах снимков
│   │   │   ├── browser/                       # браузерные проверки
│   │   │   │   ├── scenarios/                 # сценарии снимков: violation, clean, inconclusive (12 файлов)
│   │   │   │   ├── helpers.ts                 # построители сайтов и сценариев
│   │   │   │   └── … 15 файлов тестов         # по одному на проверку и общие: wording, evidence, throttle
│   │   │   ├── dns/                           # DNS-проверки и разбор записей
│   │   │   │   ├── fixtures.ts                # фикстуры в памяти: одна строка на DNS-запрос
│   │   │   │   ├── zone.ts                    # мини-DSL зоны для тестов
│   │   │   │   └── … 7 файлов тестов          # mail-01, mail-02, dmarc, spf, records, collector, data
│   │   │   └── http/                          # HDR-01, TLS-01, TLS-02, клиент и разбор HTML (10 файлов)
│   │   ├── cmp/                               # адаптеры, первый слой, распознавание, лексикон (5 файлов)
│   │   ├── collectors/                        # чистые части коллекторов
│   │   │   └── browser/                       # рекордер, cookies, страницы, документы, robots (25 файлов)
│   │   ├── core/                              # ядро и контракты
│   │   │   ├── assess.test.ts                 # уровни, overrides, кэп confidence, routing
│   │   │   ├── contract-example.test.ts       # образец чистой проверки
│   │   │   ├── gate.test.ts                   # таблица кодов выхода
│   │   │   ├── import-graph.test.ts           # L0: проверки чистые, ядро не знает верхних слоёв
│   │   │   ├── no-crm-codes.test.ts           # L0: crmCode только в JSON
│   │   │   ├── registry-completeness.test.ts  # L0: у варианта есть ruleset, тексты, фикстуры
│   │   │   ├── schema.test.ts                 # L0: схема отчёта и Ajv
│   │   │   ├── stopwords.test.ts              # L0: стоп-слова в текстах и отчётах
│   │   │   └── … 28 файлов тестов ядра        # redact, url, headers, messages, fingerprint, console, scan-*
│   │   ├── derive/                            # каталог сервисов и классификация (4 файла)
│   │   ├── reporters/                         # HTML, шаблон, Summary, PDF, дисклеймер, опции (12 файлов)
│   │   └── utils/                             # воркеры и временные каталоги тестов (2 файла)
│   ├── utils/                                 # общие помощники тестов
│   │   ├── browser.ts                         # тестовый Chromium: хосты на стенд (host-resolver-rules)
│   │   ├── certs.ts                           # тестовая PKI: CA и листья
│   │   ├── completeness.ts                    # правила полноты реестра
│   │   ├── global-tmpdir.ts                   # временный каталог прогона
│   │   ├── network.ts                         # undici-клиент с маршрутизацией на стенд
│   │   ├── offline-network-hook.ts            # preload: CLI из исходников без DNS
│   │   ├── report-fixtures.ts                 # образцы отчётов: все типы evidence
│   │   ├── report-validator.ts                # Ajv по опубликованной схеме
│   │   ├── scaling.ts                         # проверка линейного роста времени
│   │   ├── scan-harness.ts                    # фейковые коллекторы для тестов оркестратора
│   │   ├── snapshot-builder.ts                # фабрики снимка, CheckContext, загрузка фикстур
│   │   ├── stalled-pdf-hook.ts                # preload: зависшая печать PDF
│   │   ├── test-workers.ts                    # число воркеров Vitest
│   │   └── worker-tmpdir.ts                   # отдельный TMPDIR на файл теста
│   └── README.md                              # уровни L0-L3, параллельность, сеть в L2, фикстурный сервер
├── .dockerignore                              # контекст сборки образа: только то, что нужно Dockerfile
├── .editorconfig                              # LF, UTF-8, отступ 2 пробела
├── .gitignore                                 # исключает dist, schema, результаты сканов, локальный корпус
├── .node-version                              # версия Node для локальной работы (24)
├── .npmrc                                     # save-exact: зависимости запинены точно
├── action.yml                                 # composite Action: docker run образа по тегу версии
├── AGENTS.md                                  # правила для агентов и людей: жёсткие правила, команды
├── biome.json                                 # линтер и формат; запрет I/O-импортов в src/checks/**
├── CLAUDE.md                                  # подключает AGENTS.md
├── Dockerfile                                 # образ: Node 24, Chrome for Testing, non-root, tini
├── LICENSE                                    # Apache-2.0
├── NOTICE                                     # атрибуции: лицензия проекта и сторонние данные
├── package.json                               # единственный пакет, bin dsgvo-check, скрипты
├── pnpm-lock.yaml                             # lockfile pnpm
├── README.md                                  # README для пользователей (Deutsch): старт, проверки, CI
├── tsconfig.build.json                        # сборка src/ в dist/ с декларациями
├── tsconfig.json                              # typecheck: src, test, scripts, .github/scripts
└── vitest.config.ts                           # проекты unit / integration / e2e / live, воркеры, TMPDIR
```

## Куда смотреть, если нужно …

| Нужно | Куда смотреть |
|---|---|
| Добавить проверку | `src/checks/<module>/<id>.ts` и строка в `index.ts` модуля; варианты, уровни и `crm` — `test/data/ruleset/de-2026/<module>.yaml`; тексты — `test/data/texts/{de,en}/<module>.yaml`; фикстуры — `test/unit/checks/browser/scenarios/`, [fixtures.ts](../test/unit/checks/dns/fixtures.ts) для DNS или `test/fixtures/snapshots/http/<ID>/`; затем `corepack pnpm registry`. Образец — [contract-example.test.ts](../test/unit/core/contract-example.test.ts), шаги — в [AGENTS.md](../AGENTS.md) |
| Поменять уровень, `gating`, `crmCode` или имя варианта | [browser.yaml](../test/data/ruleset/de-2026/browser.yaml), [http.yaml](../test/data/ruleset/de-2026/http.yaml), [dns.yaml](../test/data/ruleset/de-2026/dns.yaml) в `test/data/ruleset/de-2026/`; затем `corepack pnpm registry` обновит таблицу §2.1 в [docs/03-checks.md](03-checks.md) |
| Поменять текст находки | [browser.yaml](../test/data/texts/de/browser.yaml), [http.yaml](../test/data/texts/de/http.yaml), [dns.yaml](../test/data/texts/de/dns.yaml) в `test/data/texts/de/` и их зеркало в `en/`; правила формулировок — [wording-guide.md](legal/wording-guide.md), стоп-слова проверяет [stopwords.test.ts](../test/unit/core/stopwords.test.ts) |
| Поменять шаблон отчёта | разметка и стили — [report.html](../test/data/report/report.html); подписи — [report.yaml](../test/data/texts/de/report.yaml) (и в `en/`); какие данные попадают в шаблон — [report-view.ts](../src/reporters/report-view.ts); язык шаблона — [template.ts](../src/reporters/template.ts); PDF печатает тот же HTML ([pdf.ts](../src/reporters/pdf.ts)). Консоль и Job Summary — [console.ts](../src/reporters/console.ts) и [summary.ts](../src/reporters/summary.ts) |
| Добавить сервис в каталог или сменить его категорию | `test/data/services/*.yaml` (формат записи — [_catalog.yaml](../test/data/services/_catalog.yaml)); какая проверка владеет категорией — [routing.yaml](../test/data/routing.yaml) |
| Поддержать новый CMP или подпись кнопки | адаптер в `src/cmp/adapters/` и регистрация в [src/cmp/index.ts](../src/cmp/index.ts); подписи кнопок — [lexicon.yaml](../test/data/cmp/lexicon.yaml); ручной стенд — `test/fixture-server/sites/cmp/<имя>/` и [sites.ts](../test/fixture-server/sites.ts); тесты — `test/integration/cmp/` |
| Понять или изменить код выхода и порог | [gate.ts](../src/core/gate.ts) (чистая функция) и [gate.test.ts](../test/unit/core/gate.test.ts) |
| Проверить, что в снимок не попали значения | [redact.ts](../src/core/redact.ts), [email.ts](../src/core/email.ts), [url.ts](../src/core/url.ts), [headers.ts](../src/core/headers.ts); редактирует коллектор до записи |
| CI проекта и релиз | [ci.yml](../.github/workflows/ci.yml), [release.yml](../.github/workflows/release.yml); логика шагов — в TypeScript, `.github/scripts/` |
| GitHub Action и GitLab | [action.yml](../action.yml), [шаблон GitLab](../templates/gitlab/dsgvo-check.gitlab-ci.yml), [пример](../examples/github-failing/README.md); контракты поставки проверяет [delivery-config.e2e.test.ts](../test/e2e/delivery-config.e2e.test.ts) |
| Docker | [Dockerfile](../Dockerfile), [docker/README.md](../docker/README.md), [entrypoint.sh](../docker/entrypoint.sh), [seccomp-chromium.json](../docker/seccomp-chromium.json); e2e образа — [docker.e2e.test.ts](../test/e2e/docker.e2e.test.ts), запускается только при `DSGVO_E2E_IMAGE` |
| Канарейка | [canary/README.md](../canary/README.md), [sites.example.yaml](../canary/sites.example.yaml), раннер [canary.ts](../scripts/canary.ts) и соседние `scripts/canary-*.ts`; настоящий `canary/sites.yaml` и `canary/results/` лежат только локально, в `.gitignore` |
| Запустить тесты, добавить сайт в стенд | [test/README.md](../test/README.md): уровни L0–L3, параллельность, сеть в L2, фикстурный сервер |
