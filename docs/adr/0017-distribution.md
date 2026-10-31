# ADR-0017 — Дистрибуция: GitHub Action, GitLab-шаблон, Docker-образ, npm

Этот документ фиксирует, как сканер попадает в CI пользователя и в каком порядке выпускается релиз. Нужен разработке, авторам README и пользователям, встраивающим сканер в свои пайплайны.

## Статус

`Accepted` — D24, единогласно. Дата: 2026-10-30.

## Контекст

- ТЗ: готовый GitHub Action, шаблон для GitLab CI, остальные CI — через Docker-образ; запуск одной командой.
- Docker-actions GitHub обязаны исполняться от root — значит, без sandbox Chromium; это противоречит [ADR-0016](0016-isolation-sandbox-and-egress-proxy.md). Terra-П предлагал Docker-action, в раунде 3 перешёл на composite.
- Официальный образ `mcr.microsoft.com/playwright:v1.64.1-noble` весит ~984 МБ сжатым, содержит три браузера и по умолчанию root.
- Автоскачивание Chromium при первом запуске противоречит офлайн-режиму, а postinstall ломает установку у потребителей с `strictDepBuilds` (по умолчанию в pnpm 11); digest образа до сборки неизвестен, поэтому «бамп через `extra-files` в Release PR» невыполним.

## Решение

| Канал | Решение |
|---|---|
| **GitHub** | Composite Action в корне репозитория → `docker run` образа по digest с флагами изоляции (non-root, seccomp-профиль образа, `cap-drop`, `read-only`, tmpfs, лимиты, без secrets и `docker.sock`); inputs только через `env`; outputs `exit-code` и пути к отчётам; Job Summary; `actions/upload-artifact` по SHA через `if: always()`, `retention-days: 14`. Режим `node` (npx + системный Chrome) — после MVP. Docker-action не используется |
| **GitLab** | Версионированный `include:remote` с `integrity` (GitLab ≥ 17.9, ⚠ проверить, факт 22); для старых self-managed — копия шаблона по commit SHA. `artifacts: when: always`, `allow_failure: false`; мягкий режим `exit_codes: [1]` — только явная опция; для self-managed без sandbox — переменная шаблона для явного `--sandbox off`. Catalog-компонент — после релиза |
| **Образ** | `node:24-bookworm-slim` + полный Chrome for Testing (new headless) через `playwright-core install --with-deps --no-shell chromium`; non-root, `tini`; собственный seccomp-профиль, который образ выдаёт командой `docker run --rm <image> seccomp-profile > dsgvo-check-seccomp.json`; `THIRD_PARTY_NOTICES`; amd64 сразу, arm64 после нативного smoke; GHCR, digest фиксируется в `action.yml` |
| **npm** | Пакет `dsgvo-check` (ESM, bin, `engines >= 24`), зависимость `playwright-core` с точным пином; браузер ставит явная `dsgvo-check install [--with-deps]`, без postinstall; без браузера → `exit 2` с готовой командой; `THIRD_PARTY_NOTICES` в пакете. Windows и macOS — best effort |
| **Альтернатива без Action** | `jobs.scan.container: ghcr.io/<org>/dsgvo-check:X.Y.Z` и `run: dsgvo-check "$URL"` — описывается в README |

**Порядок релиза:** образ → digest → коммит в `action.yml` (job после мержа) → тег. Репозиторий `example` (этап 2): красная и зелёная сборка, все коды 0/1/2, витрина без реальных третьих сторон. Сайт, поднятый в том же job, `EgressPolicy` блокирует как private-адрес; цель примера — открытый вопрос ([ADR-0016](0016-isolation-sandbox-and-egress-proxy.md), п. 5).

## Рассмотренные варианты

| Вариант | Плюс | Минус |
|---|---|---|
| Composite + `docker run` по digest (выбран) | Полный контроль флагов изоляции и пользователя; воспроизводимость по digest | Только Linux-раннеры с Docker |
| Docker-action (`runs.using: docker`) | Проще `action.yml` | Root обязателен → sandbox выключен; нет контроля seccomp и cap-drop |
| JS-action (`node24`) с бандлом | Linux, macOS, Windows | Закоммиченный бандл тяжело ревьюить; всё окружение job внутри |
| Composite + `npx` + `playwright install` | Без Docker | Около минуты на установку Chromium; кэш браузеров Playwright не советует |
| Официальный образ Playwright | Готов | 984 МБ, root, три браузера |
| GitLab Catalog-компонент сразу | Удобно пользователям | Отдельный проект и релизный job; `include:remote` + `integrity` даёт тот же контракт раньше |

## Последствия

- Action и шаблон держат `--sandbox require` ([ADR-0016](0016-isolation-sandbox-and-egress-proxy.md), вопрос 8); для сред без user namespaces README описывает явный `off` с диагностикой.
- README даёт одну строку запуска образа: `docker run --rm --security-opt seccomp=dsgvo-check-seccomp.json --cap-drop=ALL <image> <url>` (non-root задан в образе; профиль — из команды `seccomp-profile` выше). Голый `docker run` без профиля даёт `2` и печатает эту строку.
- Мягкий режим — по платформам ([ADR-0006](0006-exit-codes-and-gate.md)). GitHub: `continue-on-error`; Action печатает `::warning::` и строку в Summary, если среди `exitReasons` есть `check-error`. GitLab: явная опция `allow_failure: exit_codes: [1]`; шаблон печатает все `exitReasons` в stderr, JUnit несёт `<error>`. Цена: при наличии находки job проходит и при упавшей проверке.
- `THIRD_PARTY_NOTICES` в npm-пакете и OCI-образе: лицензии всех распространяемых зависимостей и данных, для autoconsent (MPL-2.0) — текст лицензии и ссылка на исходник точной версии, атрибуция GHSA (CC BY 4.0), NOTICE Apache-зависимостей; L0-проверка полноты.
- Поставка данных (каталог, ruleset, тексты) идёт внутри версии пакета и образа; `datasets[]` в отчёте показывает снапшоты.
- Supply chain (release-please, npm trusted publishing и provenance, `actions/attest`, SBOM, actions по SHA, Renovate с группой Playwright) — кандидат ADR-033 консенсуса: предложение модератора к этапу 4, в раунде 3 не голосовалось; в этом наборе не оформлен.

## Ссылки

- Консенсус: [D06, D24, D25](../consensus/README.md#2-итоговые-решения); [§3 D25](../consensus/README.md#3-подробности-по-спорным-точкам-и-точкам-изменённым-меньшинством); [§5.2](../consensus/README.md#52---fail-on-и-коды-012), [§5.8](../consensus/README.md#58-отчёты-csp-и-уведомления-о-лицензиях); ошибки 26, 34, 58, 60, 81, 90; факты 2, 8, 22, 23; кандидаты ADR-027–029; [errata №23, 38, 44, 50](../consensus/round-4/errata.md).
- Критика: [Terra-К D24, §4 «Поставка и цепочка данных»](../consensus/round-3/codex-gpt-6.1-terra_critique.md), [Opus-К D24](../consensus/round-3/claude-opus-5.5_critique.md), [Fable-К D24](../consensus/round-3/claude-fable-5.1_critique.md), [Sol-К D24](../consensus/round-3/codex-gpt-6.1-sol_critique.md); [votes-matrix D24](../consensus/round-3/votes-matrix.md#d24).
- Предложения: [Opus-П §10.1–10.5](../consensus/round-2/claude-opus-5.5_proposal.md), [Fable-П §10](../consensus/round-2/claude-fable-5.1_proposal.md), [Sol-П §10](../consensus/round-2/codex-gpt-6.1-sol_proposal.md).
- Ресёрч: [engineering §4.1–4.5](../01-research/engineering-ci-distribution.md); [browser-automation §9](../01-research/browser-automation.md); [R1-red-team §4](../consensus/round-1/codex-gpt-6.1-terra_redteam-qa.md).
