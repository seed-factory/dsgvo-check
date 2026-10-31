# ADR-0008 — Fingerprint, подавления, baseline и дедупликация

Этот документ фиксирует, как находка получает стабильный ключ, как её подавляют и как baseline отсекает известное. Нужен разработке и пользователям CI, которые ведут `.dsgvo-check/` в репозитории сайта.

## Статус

`Accepted` — D21: единогласно по технологии; состав fingerprint изменён меньшинством (Opus-К, техническая ошибка всех четырёх предложений), возражение Sol-К принято как документированное ограничение. Дедупликация по `routing.yaml` — рекомендация панели по вопросу 6; маппинг `crmCode` ждёт заказчика, routing разработку не блокирует. Дата: 2026-10-30.

## Контекст

- Все четыре предложения включали хост цели (eTLD+1) в ключ. На preview-деплоях (`*.vercel.app`, `*.netlify.app` — private suffix PSL) каждый PR получает свой eTLD+1, и baseline не совпадает ни по одной находке.
- Страницы и фаза в ключе (Sol-П, Terra-П) дают мигание при эвристической выборке страниц и дубль одного трекера в A и A′.
- Baseline, учитывающий только новые отпечатки, скрывает рост уровня (Fable-П).
- Один трекер даёт запрос, cookie, dataLayer-событие и запись в инвентаре — без дедупликации это четыре «обвинения» за один факт.

## Решение

- `fingerprint = "sha256:" + hex(sha256(JCS({v: 1, checkId, variantGroup, subject})))`. В ключ **не входят**: хост цели, страницы, фаза, время, query, значения, текст сообщения, severity.
- `subject` задан для каждого ID каталога: `serviceId` (CONSENT-01/05/06, TRACK-01, EMBED-*, PRIV-01; неизвестные — `unknown:<eTLD+1 третьего лица>`); `name` + (`first-party` | eTLD+1) + `path` + partitioned (CONSENT-02, HDR-02); имя заголовка (HDR-01); вид записи (MAIL-*, DNS-01); тип документа (LEGAL-01); `claimId` + `serviceId` (PRIV-02); `consent-ui` (CONSENT-03/04); `product` + CVE (VULN); путь (FILE-01); `http-entry:` + роль хоста (TLS-01); `certificate:` + роль хоста (TLS-02); `resourceType` + (`first-party` | eTLD+1) (TLS-03); версия протокола + роль хоста (TLS-04); `security.txt` (SEC-01); id устаревшего термина (LEGAL-02); endpoint (ADMIN-01); id правила axe (BFSG-01); метрика (PERF-01). Роль хоста — `final` или `pair` (второй из пары www/apex): TLS-находки различаются ролью, а не именем хоста.
- **Подавления** — `.dsgvo-check/suppressions.yaml`, `version: 1`; в каждой записи обязательны `reason` и `expires`, `owner` по желанию. Матчеры: `fingerprint`, `checkId` (glob, включая `CHECK.variant`), `serviceId` (рекомендуемый). Подавленная находка остаётся в отчёте с флагом; просроченное правило снова учитывается и печатает предупреждение. Нельзя подавить `error`, `inconclusive`, диагностику и неполное покрытие.
- **Baseline** — `dsgvo-check baseline create report.json`; файл с `version: 1` хранит `fingerprint`, `severity`, `fingerprintVersion`. При `--baseline` гейтят новые отпечатки и отпечатки с выросшим уровнем или сменой `variantGroup`. В 1.0 `fingerprintVersion` = 1; baseline с другой версией — ошибка с понятным сообщением. `baseline migrate` — бэклог, вместе с `fingerprintVersion` 2. Канарейка baseline сама не обновляет.
- **Дедупликация как данные** (`data/routing.yaml`): analytics, ads, session-recording, tag-manager, cdn, payment, consent-provider, unknown → CONSENT-01; fonts → EMBED-01, maps → EMBED-02, video → EMBED-03, captcha → EMBED-04, widget/social/reviews/chat → EMBED-05. Независимые оси: хранилище — CONSENT-02, Consent Mode — CONSENT-06, отсутствие баннера — CONSENT-03, после отказа — CONSENT-05. TRACK-01 — `info`-инвентарь; связь с CONSENT-находками — через общие `evidenceIds` (`evidence[].id`) и `related[]`, отдельного `observationId` нет. В отчёте связанные находки группируются по `serviceId`; подавить их можно одним правилом по `serviceId`.
- Конфиг `.dsgvo-check.yaml`: `pages:` закрепляет выборку, `rules:` переопределяет уровень по варианту (`EMBED-01.fonts-loaded`) или проверке (без подъёма `info`-вариантов); overrides видны в `scan.options.overrides`. Варианты с `locked: true` (`CONSENT-04.banner-not-recognized`, `CONSENT-04.cmp-not-supported`) не переопределяются ни на каком уровне: такое правило — ошибка конфига (`invalid-input`, код `2`); инвариант проверяют assess, схема конфига и L0-тест.

## Рассмотренные варианты

| Вариант | Плюс | Минус |
|---|---|---|
| Ключ без хоста, страниц и фазы (выбран) | Baseline переживает preview-деплои и эвристическую выборку | Новая затронутая страница не всплывает отдельно — страницы в evidence, выборку фиксирует `pages:` |
| eTLD+1 цели в ключе (Fable-К) | Один baseline на несколько сайтов | Ломается на private-suffix хостах |
| Маршрут/страница и фаза в ключе (Sol-П, Terra-П) | Точнее локализация | Мигание baseline, дубли A/A′ |
| Baseline только по новым отпечаткам | Проще файл | Рост `warning → critical` остаётся скрытым |
| TRACK-01 как владелец уровня для analytics/ads (вариант (а) вопроса 6) | Один ID для трекеров | Расходится с примером каталога для CONSENT-01 и тремя из четырёх предложений |

## Последствия

- Смена владельца категории в routing — minor-релиз с разделом «Baseline changes» в CHANGELOG.
- First-party cookie в `subject` несёт маркер `first-party`, а не хост.
- Сопоставление `variantGroup` объявляется статически в `CheckDefinition` ([ADR-0004](0004-pipeline-and-check-contract.md)).
- Ограничение «агрегация скрывает новую страницу» документируется в README.

## Ссылки

- Консенсус: [D21](../consensus/README.md#2-итоговые-решения); [§3 D21](../consensus/README.md#3-подробности-по-спорным-точкам-и-точкам-изменённым-меньшинством); [§5.4–5.5](../consensus/README.md#54-fingerprint-подавления-baseline); [дедупликация в §4](../consensus/README.md#4-сводная-спецификация-проверок); ошибки 3, 8, 41, 51; вопрос 6; [errata №14, 27, 60](../consensus/round-4/errata.md).
- Критика: [Opus-К §4.5](../consensus/round-3/claude-opus-5.5_critique.md), [Sol-К D21](../consensus/round-3/codex-gpt-6.1-sol_critique.md), [Fable-К D21](../consensus/round-3/claude-fable-5.1_critique.md); [votes-matrix D21](../consensus/round-3/votes-matrix.md#d21).
- Предложения: [Opus-П §5.5, §6.1](../consensus/round-2/claude-opus-5.5_proposal.md), [Sol-П §5 «Fingerprint и baseline»](../consensus/round-2/codex-gpt-6.1-sol_proposal.md).
- Ресёрч: [engineering §3.4–3.5](../01-research/engineering-ci-distribution.md).
