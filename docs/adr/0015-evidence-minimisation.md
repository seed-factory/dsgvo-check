# ADR-0015 — Минимизация evidence и артефактов

Этот документ фиксирует, что из наблюдаемого сканер записывает в снимок, отчёт и логи, а что никогда. Нужен разработке коллекторов, авторам репортеров и заказчику как основа условного дисклеймера.

## Статус

`Proposed` — большинство правил принято единогласно (D20), но скриншот области баннера по умолчанию ждёт ответа заказчика на вопрос 11 «Evidence и хранение» с оценкой UrhG § 51 (⚠ проверить, факт 14). Решение обратимо одним флагом. Дата: 2026-10-30.

## Контекст

- Значения `_ga`, `_fbp`, TC-String — идентификаторы (EuGH IAB Europe C-604/22), по которым третьи лица могут связать сессию с IP сканера. Хеш значения — связуемый псевдоним (ошибка 35), дисклеймер «без персональных данных» стал бы ложным.
- Во всех предложениях не редактировались `rua/ruf=mailto:` в DMARC, `Contact: mailto:` в `security.txt`, имена из `/?author=1` и блок контактов Impressum (ошибка 6).
- HAR с `content: 'omit'` не чистит заголовки и cookies (ошибка 20).
- Скриншот баннера — главное человеческое доказательство для CONSENT-04 и защита по § 824 BGB; полностраничный скриншот может содержать фото людей и отзывы.

## Решение

| Данные | Что пишем | Что не пишем никогда |
|---|---|---|
| Cookies, Web Storage, TC-String | `name`, `domain` или `first-party`, `path`, `partitionKey`, `secure/httpOnly/sameSite`, `lifetime`, `length`, `setter`, `state`, `phase` | значения — ни открыто, ни хешем |
| Запросы | очищенный `url`, `method`, `resourceType`, `initiator`; `delivery` (`attempted / blocked-by-browser / sent`), `result` (`response / failed / aborted / none`), `provenance` (`network / service-worker / http-cache / memory-cache`); монотонный `tMs` от `scan.startedAt`, `navigationId`, `actionId`, `frameId`, `parentRequestId`; `features` — безопасные признаки; `connectedIp` | POST-тела, тела ответов; значения параметров; query — allowlist параметров со значением `[redacted]` |
| DNS и security.txt | записи с `mailto:` замаскированным до домена | адреса в `rua/ruf`, `Contact:` |
| ADMIN-01 | только счётчики | имена пользователей |
| Документы | текст по разделам, manifest полноты, `sha256` | блок контактов Impressum в цитатах; цитаты ≤ 200 знаков |
| Скриншот | только область баннера: `page.screenshot()` текущего viewport без прокрутки, до любого действия и вместе с геометрией, затем обрезка по `box` контейнера; только если контейнер однозначен и его `box` ≤ 50 % viewport (одно правило для адаптеров и эвристического кандидата), иначе снимка нет, limitation `screenshot-skipped`; desktop и M, JPEG ≤ 200 КБ, файл в артефактах и в HTML, `sha256` и `crop` в JSON; `--no-screenshots` выключает | полностраничные скриншоты; `locator.screenshot()` (прокручивает элемент); данные изображения в JSON |
| Трассировка | — | HAR, `tracing`, NetLog выключены; FILE-01 тела не хранятся |
| Пользовательские данные | — | `--contact` в отчёт не попадает |

- Редактирование выполняется **в коллекторе** до снимка, логов, исключений и артефактов. Безопасные признаки `features` (`identifier {kind, matchesStoredIdentifier}`, `eventType`, `consentSignal`) извлекаются до удаления значений и сохраняются с `parserVersion` и `observationSource`; пересчёт по снимку обещан только для них. Корреляция идентификаторов — в памяти скана (HMAC с одноразовым ключом), без экспорта.
- L0-тест ищет значения cookies и `mailto:` в фикстурах вывода всех репортеров.
- Retention артефактов в шаблонах Action и GitLab — 14 дней.
- Консоль очищается от ANSI, bidi-override и workflow-команд; HTML без JS с полной CSP `default-src 'none'; img-src data:; style-src 'sha256-…'; base-uri 'none'; form-action 'none'` ([ADR-0016](0016-isolation-sandbox-and-egress-proxy.md)).

## Рассмотренные варианты

| Вариант | Плюс | Минус |
|---|---|---|
| Без значений и хешей, скриншот области баннера по умолчанию (выбран) | Отчёт проверяем аудитором; обрезка по контейнеру ≤ 50 % viewport снижает риск попасть на фото людей и отзывы | Риск не исключён: контейнер бывает прозрачным или с произвольным контентом; правовая неопределённость § 51 UrhG — вопрос 11 |
| Скриншоты только opt-in (Sol-К, Terra-К) | Меньше поверхность утечки | CONSENT-04 без визуального доказательства; одним флагом включается обратно |
| `valueSha256` для cookies (Fable-П) | Корреляция между фазами в отчёте | Связуемый псевдоним; корреляция делается в памяти HMAC |
| HAR с `content: 'omit'` как «очищенный» (Opus-П) | Полная картина сети | Заголовки и cookies остаются; выключен до появления санитайзера |
| Флаг `--include-cookie-values` (ресёрч R1) | Для отладки | Любая возможность экспорта делает дисклеймер условным — удалён |

## Последствия

- `evidence.screenshot` хранит путь, `sha256` и `crop {box, viewport}`; HTML встраивает только перекодированные нами изображения как `data:` (их разрешает `img-src data:`).
- Абзац дисклеймера про скриншоты — условный; при ответе «opt-in» меняется значение флага по умолчанию, схема не меняется.
- Для `inconclusive` сохраняются измеренные факты для ручной проверки (кнопки, тексты, блокировка, скриншот области).
- Запрет публикации отчётов о третьих лицах — в Nutzungshinweise README.

## Ссылки

- Консенсус: [D05, D20](../consensus/README.md#2-итоговые-решения); [§3 D20](../consensus/README.md#3-подробности-по-спорным-точкам-и-точкам-изменённым-меньшинством); [§5.3 Evidence](../consensus/README.md#53-evidence); [§5.8](../consensus/README.md#58-отчёты-csp-и-уведомления-о-лицензиях); ошибки 6, 20, 27, 35, 79; факт 14; риск 10; вопрос 11; [errata №16, 28, 34, 35, 43](../consensus/round-4/errata.md).
- Критика: [Fable-К §4.3](../consensus/round-3/claude-fable-5.1_critique.md), [Sol-К §4.10](../consensus/round-3/codex-gpt-6.1-sol_critique.md), [Opus-К D20](../consensus/round-3/claude-opus-5.5_critique.md), [Terra-К §4 «HTML, PDF и логи»](../consensus/round-3/codex-gpt-6.1-terra_critique.md); [votes-matrix D20](../consensus/round-3/votes-matrix.md#d20).
- Предложения: [Opus-П §11.4–11.5](../consensus/round-2/claude-opus-5.5_proposal.md), [Fable-П §11](../consensus/round-2/claude-fable-5.1_proposal.md), [Terra-П §11](../consensus/round-2/codex-gpt-6.1-terra_proposal.md).
- Ресёрч: [legal-basis-map §4.3–4.4](../01-research/legal-basis-map.md); [engineering §6.7–6.8](../01-research/engineering-ci-distribution.md).
