# ADR-0016 — Изоляция: Chromium sandbox и egress-прокси против SSRF

Этот документ фиксирует, как сканер защищает CI-раннер от недоверенного сайта: sandbox браузера, единая сетевая граница `EgressPolicy` и профиль контейнера. Нужен разработке, авторам Action и GitLab-шаблона и тем, кто пишет модель угроз в README.

## Статус

`Proposed` — ждёт ответа заказчика на вопрос 8 «Sandbox на трёх входах ТЗ» (`npx`, `docker run`, CI) ([раздел 8](../consensus/README.md#8-вопросы-заказчику)) и данных спайка С3 (⚠ проверить, факт 2). D25 — спор; `require` без `auto` — решение модератора. `EgressPolicy`, `chromiumSandbox: true`, полная CSP и профиль контейнера — поправки раунда 4б ([README §5.7–5.8](../consensus/README.md#57-сетевая-граница-egresspolicy)), без спора.

## Контекст

- Сканер открывает чужие сайты с произвольным JS в CI, где рядом лежат metadata-эндпоинты раннера и внутренняя сеть. Две угрозы: побег из рендерера (нужен sandbox Chromium) и SSRF через редиректы, DNS-rebinding и WebRTC (нужна проверка IP при фактическом соединении — на всех путях, включая сырые сокеты TLS-02 и TLS-04).
- У Playwright по умолчанию `chromiumSandbox: false`: non-root и seccomp сами sandbox не включают.
- Docker: с дефолтным seccomp-профилем sandbox Chromium не поднимается даже от non-root, с `--cap-add=SYS_ADMIN` поднимается; профиль Playwright в OrbStack/arm64 контейнер не запустил (эксперимент ресёрча §10, ⚠ amd64). Причина — фильтр namespace-флагов `clone`/`unshare` без `CAP_SYS_ADMIN`. Консенсус (§3 D25) пишет, что `CLONE_NEWUSER` и `unshare --user` разрешены, а блокируются прочие `CLONE_NEW*` (PID, NET); так написано в таблице docs.docker.com, но `default.json` moby маскирует `clone` значением `0x7E020000`, куда входит и `CLONE_NEWUSER`, а `unshare` разрешает только с `CAP_SYS_ADMIN` (⚠ проверить, факт 2, С3). На решение это не влияет: образу нужен собственный seccomp-профиль.
- Хост: на Ubuntu ≥ 23.10 AppArmor `apparmor_restrict_unprivileged_userns` может давать у Chrome for Testing «No usable sandbox» (⚠ факт 2). Docker-actions GitHub исполняются от root. Hosted runners GitLab.com (`saas-linux-*`) работают в privileged-режиме в отдельной VM (проверено модератором по документации GitLab).
- Ресёрч R1 предлагал SSRF-защиту через `context.route` — она отключает HTTP-кэш и оставляет гонку DNS. Запрет IPv6 целиком (Terra-П) исключил бы IPv6-only сайты. `--proxy` «на все коллекторы» неисполним: DNS через HTTP CONNECT не ходит.

## Решение

1. **Sandbox:** `--sandbox require | off`, по умолчанию `require`; `require` ⇒ `chromiumSandbox: true` и запуск без `--no-sandbox`. Не поднялся → `exit 2` с инструкцией (`sandbox-unavailable`). `off` — только явно: диагностика `SCAN-SANDBOX-OFF`, предупреждение в консоли и Summary, `2` при `--strict`. Режима `auto` и автоматического fallback нет. Поведение на трёх входах ТЗ:

   | Вход | Что делает сканер | Если sandbox не поднялся |
   |---|---|---|
   | `npx dsgvo-check <url>` | userns-sandbox Chromium | `2`; сообщение называет причину (AppArmor, нет user namespaces) и три пути: образ; системная настройка AppArmor или userns, которую делает сам пользователь (сканер её не меняет); явный `--sandbox off` |
   | `docker run <image> <url>` | образ несёт seccomp-профиль и выдаёт его командой `docker run --rm <image> seccomp-profile > dsgvo-check-seccomp.json`; README даёт строку запуска с `--security-opt seccomp=…`, `--cap-drop=ALL`, non-root | с дефолтным seccomp → `2`, сообщение печатает точную строку запуска с профилем |
   | CI: Action, GitLab-шаблон | Action сам передаёт профиль в `docker run`; GitLab.com `saas-linux-*` — privileged-VM (⚠ С3) | `2` с инструкцией; `off` — только явной переменной шаблона (self-managed) |

   Конфликт с «одной командой без конфига» из ТЗ назван прямо: на хосте без userns-sandbox и при голом `docker run` первая команда даёт `2`, а не отчёт (вопрос 8).
2. **`EgressPolicy` — один модуль на все соединения с сайтом:** in-process HTTP/CONNECT-прокси браузера, undici (инжектируемые `connect` и `lookup`), `node:tls` в TLS-02 и `net.Socket` в TLS-04. Имя разрешается своим резолвером (все A и AAAA), проверяется **каждый** адрес, соединение открывается только с проверенным адресом без повторного разрешения — DNS-rebinding не проходит. Запрещены loopback, private (RFC 1918, IPv6 ULA), link-local, metadata (`169.254.169.254`, IPv6-аналоги) и прочие специальные диапазоны (в том числе CGNAT); IPv4-mapped IPv6 проверяется по встроенному IPv4; публичный IPv6 разрешён. QUIC и non-proxied UDP у WebRTC выключены; блокировка пишется как `SCAN-PRIVATE-REQUEST-BLOCKED`. Тот же инжектируемый `lookup` подменяет хосты в L2.
3. **DNS-коллектор** (MAIL-*, DNS-01) с сайтом не соединяется и идёт к системному резолверу или `--resolver` напрямую, в том числе при `--proxy`; это пишется в `scan.environment.egress.collectors` и Messumgebung.
4. **`--proxy` в 1.0** — только `http://` (HTTP CONNECT) для браузера, undici и TLS-коллекторов; SOCKS5 — бэклог; учётные данные прокси в отчёт и логи не попадают. **Граница SSRF за upstream:** адрес проверяется локально, upstream получает `CONNECT <проверенный IP>:<port>`, SNI и `Host` идут внутри туннеля. Гарантия — адрес назначения каждого соединения прошёл нашу проверку; сеть, ACL и NAT самого upstream — вне границы, README говорит это прямо. Цена: CDN-узел выбирается по локальному резолверу, а не по региону выхода (limitation в Messumgebung). Upstream, не принимающий IP-литерал в CONNECT, — ошибка конфигурации без фолбэка на имя хоста (⚠ проверить, факт 31).
5. Исключений для private-адресов консенсус не предусматривает: сервис, поднятый в том же job (репозиторий `example`), `EgressPolicy` заблокирует, и скан даст `2`. Поэтому цель примера — публично доступная витрина ([04, «Открытые вопросы»](../04-quality-and-delivery.md#открытые-вопросы)) или явное исключение; опция `--allow-private` — **предложение автора, не согласовано**, архитектура (ОВ-9) предлагает обратное — флага нет, адреса фикстур разрешаются адресно.
6. **Контейнер:** non-root, `tini`, `--cap-drop=ALL`, `no-new-privileges`, собственный seccomp-профиль для sandbox, `--read-only` с `tmpfs /tmp`, лимиты памяти и pids, без secrets, OIDC-токенов и `docker.sock`; конфиг read-only, отдельный output-том. `acceptDownloads: false` (D25), минимальный `env` браузеру.
7. **Поверхности вывода:** HTML без JS с полной CSP одной строкой `<meta http-equiv>`: `default-src 'none'; img-src data:; style-src 'sha256-<хеш блока style>'; base-uri 'none'; form-action 'none'` — `default-src` служит fallback, поэтому без `img-src` и `style-src` отчёт теряет скриншоты и стили. Атрибутов `style=` нет, `'unsafe-inline'` — только если хеш технически невозможен. Контекстное экранирование, URL текстом, `data:` только для своих скриншотов; консоль и логи чистятся от C0/C1, bidi-override и workflow-команд; `$GITHUB_OUTPUT` — только значения, контролируемые инструментом; PDF печатается в офлайн-контексте.
8. **Модель угроз в README честная:** in-process прокси — политика для неуязвлённого браузера; принудительная сетевая граница (сканер в `--internal`-сети плюс контейнер-прокси) в одном контейнере невыполнима и идёт в бэклог.

## Рассмотренные варианты

| Вариант | Плюс | Минус |
|---|---|---|
| (а) `require` на всех входах + явный `off` с диагностикой (выбран) | Нет тихой деградации; два режима проще трёх; на ноутбуке, где рядом личные данные и ключи, sandbox включён | `npx` на хостах с AppArmor-ограничением и голый `docker run` дают `2` с инструкцией — конфликт с «одной командой» (вопрос 8) |
| (б) `require` в Action, шаблоне и образе; у `npx` вне CI — `off` с громкой диагностикой | «Одна команда» на хосте работает | Sandbox выключается там, где он важнее всего; пересмотр, если С3 покажет массовый отказ `npx` |
| (в) `auto` с fail-open (Opus-К, Fable-К) | GitLab shared runners «из коробки» | Аргумент ослаб: hosted runners GitLab.com privileged; тихая потеря sandbox |
| (г) Только `require`, без `off` | Максимум безопасности | Где sandbox не поднимается (self-managed раннер без privileged и своего seccomp, хост с AppArmor-ограничением), скан невозможен вовсе; с явным `off` такие среды работают с диагностикой `SCAN-SANDBOX-OFF` |
| SSRF через `context.route` (ресёрч R1) | Без прокси | Отключает кэш, гонка DNS, не покрывает undici, TLS и WebRTC |
| Прокси только для браузера и undici | Меньше кода | Сырые сокеты TLS-02/TLS-04 вне границы (errata №41) |
| Принудительный egress из двух контейнеров (Sol-К, Terra-К) | Настоящая граница | В одном контейнере и composite-Action невыполнимо — бэклог |
| `--cap-add=SYS_ADMIN` ради sandbox | Поднимается везде | Слишком широкая capability; Playwright советует только локально |

## Последствия

- Спайк С3 — sandbox на трёх входах ТЗ: GitHub hosted (Action и шаг `npx` на `ubuntu-24.04`), GitLab.com `saas-linux-*`, голый `docker run` с дефолтным seccomp и с профилем образа (amd64), хост Ubuntu 24.04 с AppArmor. Спайк С5 — `EgressPolicy` и прокси (`proxy-chain` или свой CONNECT; HTTP/2, QUIC, preconnect, WebRTC; `lookup` для undici, `node:tls`, `net`; приём upstream'ом CONNECT на IP-литерал; ⚠ проверить, факты 4, 31).
- `EgressPolicy` и прокси реализуются на этапе 2 вместе с Action; до этого SSRF-граница прототипа — проверка IP при навигации и в инжектируемом `lookup`, без претензии на полноту, и прототип не запускается в CI с секретами ([ADR-0019](0019-prototype.md)).
- Журнал прокси — дополнительный источник для CONSENT-05 (новые CONNECT к трекер-хостам после отказа) и для пробела `pagehide`-beacons.
- L3-тесты: sandbox на трёх входах и отсутствие `--no-sandbox` в аргументах запуска; SSRF по всем путям `EgressPolicy` (браузер, undici, TLS-02, TLS-04, upstream) — RFC 1918, loopback, link-local, CGNAT, IPv6 ULA, IMDS v4/v6, редирект на `169.254.169.254`, имитация DNS-rebinding. L2: «ноль сети» у HTML-отчёта, скриншоты и стили отображаются.
- Быстрые обновления Chromium — часть модели безопасности.

## Ссылки

- Консенсус: [D11, D24, D25](../consensus/README.md#2-итоговые-решения); [§3 D25](../consensus/README.md#3-подробности-по-спорным-точкам-и-точкам-изменённым-меньшинством); [§5.7](../consensus/README.md#57-сетевая-граница-egresspolicy), [§5.8](../consensus/README.md#58-отчёты-csp-и-уведомления-о-лицензиях); «Проверено модератором» в [разделе 1](../consensus/README.md#1-как-шёл-консенсус); ошибки 54, 60, 70, 77; факты 2, 4, 31; риски 6, 11; вопрос 8; [errata №38–44](../consensus/round-4/errata.md).
- Критика: [Opus-К §4.9](../consensus/round-3/claude-opus-5.5_critique.md), [Terra-К §4 «SSRF и изоляция», «HTML, PDF и логи»](../consensus/round-3/codex-gpt-6.1-terra_critique.md), [Sol-К D25](../consensus/round-3/codex-gpt-6.1-sol_critique.md); [votes-matrix D25](../consensus/round-3/votes-matrix.md#d25).
- Предложения: [Opus-П §11.3–11.4](../consensus/round-2/claude-opus-5.5_proposal.md), [Fable-П §11](../consensus/round-2/claude-fable-5.1_proposal.md), [Terra-П §11](../consensus/round-2/codex-gpt-6.1-terra_proposal.md).
- Ресёрч: [engineering §6](../01-research/engineering-ci-distribution.md); [browser-automation §9–10](../01-research/browser-automation.md); [R1-red-team §5](../consensus/round-1/codex-gpt-6.1-terra_redteam-qa.md). Docker seccomp: [docs.docker.com/engine/security/seccomp](https://docs.docker.com/engine/security/seccomp/), [moby/profiles `seccomp/default.json`](https://github.com/moby/profiles/blob/main/seccomp/default.json).
