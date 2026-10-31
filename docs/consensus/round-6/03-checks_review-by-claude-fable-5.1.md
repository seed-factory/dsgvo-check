# Раунд 6 — перекрёстная редактура `docs/03-checks.md`

Дата: 2026-10-30 · Редактор: Claude Fable 5.1 · Автор документа: Codex GPT-6.1-Sol · Линза: правовая корректность, немецкие черновики без правовых выводов, RDG / § 824 BGB, минимизация evidence.

Источники истины: [`docs/consensus/README.md`](../README.md) с поправками раунда 4б, [`round-4/errata.md`](../round-4/errata.md) (§5.2 — список для этого документа), `specs/*.md`.

## 1. Что изменено

### 1.1 Поправки консенсуса из списка модератора (errata §5.2)

| № | Раздел | Суть правки |
|---|---|---|
| 1 | §3.13 TLS-01, §3.14 TLS-02 «Правовой якорь» | «§ 19 Abs. 4 S. 2 TDDDG» → «S. 3» (Satz 2 — Stand der Technik, Satz 3 — Verschlüsselung) |
| 2 | §3.14 TLS-02 «Уровень», «Текст», «Фикстуры» | Абсолютные 14/15–30 дней → относительный порог: `warning` при остатке < min(14 д, 25 % L), `info` при < min(30 д, 50 % L), L = `notAfter − notBefore`; при L ≤ 10 д находки о сроке нет (только `lifetimeDays`). Текст `certificate-expiring` с «(Gesamtlaufzeit {lifetimeDays} Tage)». Фикстуры: 6-дневный сертификат = clean; 90-дневный на 13 / 15 / 29 / 31 днях → `warning` / `info` / `info` / нет; добавлена защита «короткоживущий сертификат → относительный порог» |
| 3 | §3.14 TLS-02 «Данные», шаги 1, 3, 4 | Ветка IP-цели: без SNI (RFC 6066), `X509Certificate.checkIP` по `iPAddress`-SAN; `node:tls` через `EgressPolicy`; фикстура с IP-целью; `{target}` в текстах = Hostname или «IP-Adresse {ip}» |
| 4 | §3.6 CONSENT-04, таблица вариантов | `blocking-no-reject` получил условие `acceptAvailableAtFirstLayer: true`; новый вариант `no-choice-at-first-layer` → `info` (ручная оценка); `banner-not-recognized`/`cmp-not-supported` — `locked: true`, `gating: false`, не повышаются ни ruleset, ни overrides. Добавлены фикстуры (экран «только Einstellungen»; override на `banner-not-recognized` → `invalid-input`), черновик текста `CONSENT-04.no-choice-at-first-layer`, текст `blocking-no-reject` теперь фиксирует наличие Zustimmungsoption |
| 5 | §3.3 CONSENT-01, шаг 3, Evidence, Уровень, фикстуры, текст | `identifierPresent` → `features.identifier.kind` (`stored-match / persistent-param / user-supplied / per-load / none`) и `matchesStoredIdentifier`; `critical` только при `delivery: sent` + `result: response` и устойчивом идентификаторе; `per-load`/`none` → `warning`; фикстура нарушения через `stored-match`, контрпример `per-load`; текст «mit einer dauerhaften Kennung ({identifierKind})» |
| 6 | §4 CONSENT-05, шаги 3–7, Evidence, таблица уровней, фикстуры, тексты | Подтверждённый отказ = `origin: action` после клика → `stored` после reload + `decision.responded: true`; default-denied (Cookiebot: необязательные категории изначально `false`) → `inconclusive` «Ablehnung nicht bestätigt»; хит `critical` требует устойчивого идентификатора как в CONSENT-01; время — `tMs` относительно `actionId`; добавлен текст limitation «Ablehnung nicht bestätigt (nur Ausgangszustand des CMP)» |
| 7 | §1.3 таблица evidence, CONSENT-01, CONSENT-05 | `request`: `tStartMs`, `state` → `tMs` (монотонное от `scan.startedAt`), `navigationId`, `actionId`, `frameId`, `parentRequestId`, `delivery`, `result`, `provenance`, `features`; `cookie/storage` — `phase`, `tMs`, `navigationId`, `actionId`; `tls` — `ipTarget`, `lifetimeDays`; `cmp` — `vendorRole`, `kind`/`kindConfidence` от `classifyFirstLayer`, `acceptAvailableAtFirstLayer`; `consent-state` — `origin`-enum и `decision {responded, method}`; `screenshot` — `crop`, `screenshot-skipped`. §3.7 TRACK-01: `observationId` → общие `evidenceIds` и `related[]` |
| 8 | §3.10 MAIL-01, шаг 7, якорь, тексты | `t=y` (RFC 9989) и legacy `pct<100` (RFC 7489, в RFC 9989 удалён, Appendix A.6) разведены; `pct` — отдельный `info`-вариант, добавлен черновик `MAIL-01.legacy-pct`; ⚠ «месяц RFC 9989» снят — май 2026 подтверждён в 4б (строка Q7 удалена) |
| 9 | §5.7 MAIL-03, §5.9 TLS-04 | MAIL-03: «только `info`» → `info` «unter N geprüften Selektoren nicht gefunden»; generic-список привязан к вопросу 16 заказчику (в «Данные», «Открытые вопросы» и Q10). TLS-04: «по умолчанию при включённой проверке», handshake через `EgressPolicy`. DNS-01 уже перечислял `warning` за bogus — без изменений |
| 10 | §5.6 VULN-02 «Уровень» | `not_applicable` только без WP-компонентов, JS-библиотек и Next.js/Nuxt; отсутствие WP пропускает только WP-ветку |
| 11 | §2 реестр, §3.1 PRIV-01 «Данные», «Уровень» | DSE извлекается в `A` без кликов и дополняется в `B` после подтверждённого отказа; согласие ради документа не нажимается; баннер не закрыт при полном manifest → `completed`/`partial` с limitation `banner-open`, не `inconclusive`. Слов «самая частая P0» в документе не было — не добавлены |
| 12 | §1.3 скриншоты | `page.screenshot()` viewport до любого действия и обрезка по `box`; `locator.screenshot()` не используется; снимок только при однозначном контейнере ≤ 50 % viewport, иначе `screenshot-skipped`; то же в Evidence CONSENT-04 |
| 13 | §8 Gate | Добавлена таблица `subject` fingerprint для всех ID по README §5.4 (TLS-01 `http-entry:` + роль хоста, TLS-02 `certificate:` + роль, TLS-03, TLS-04, P2) |

### 1.2 Остальные расхождения с обновлённым README, найденные самостоятельно

| Раздел | Суть правки | Основание |
|---|---|---|
| §1.1 | Политика 429/503 общая для браузера и проб (`Retry-After` ≤ 30 с, один повтор, затем без новых навигаций); фаза `C` раскрывает IP сканирующей машины — в Messumgebung | D08, D09 |
| §1.2 | `locked`-варианты не переопределяются ни на каком уровне → `invalid-input`, код `2`; overrides видны в `scan.options.overrides` | 5.4 |
| §1.3 | Единый `EgressPolicy` для браузера, undici, `node:tls`, `net.Socket`; DNS-коллектор идёт к резолверу напрямую, в т. ч. при `--proxy`, пишется в `environment.egress.collectors`; `features` с `parserVersion`, `observationSource`; пересчёт по снимку только для сохранённых признаков | 5.3, 5.7, D05 |
| §2 | Этап 1 закрывает прототип по `docs/prototype/BRIEF.md`, не релиз и не его ворота | §2а |
| §3.3 CONSENT-01 «Данные» | Enum `attempted … from-cache` → три оси `delivery / result / provenance` | 5.3 |
| §3.5 CONSENT-03 текст | «Der EWR-Messstandort ist …» → «Region laut Nutzerangabe: …» — обязательная оговорка D11 | D11 |
| §3.6 CONSENT-04 шаг 4 | Названы `classifyFirstLayer(facts, lexicon)` в core и контракт адаптера `extract / act / verify`; адаптер сообщает `vendorRole`, но не класс | D12 |
| §3.13 TLS-01 «Данные» | HTTP-пробы — undici через `EgressPolicy` | 5.7 |
| §7.5 SCAN-THROTTLED | Условие расширено на браузерные навигации (429/503 на навигации или ≥ 3 за фазу после `Retry-After` и повтора); текст без «Drei Proben» | D09, 5.2 |
| §7.6 SCAN-TIMEOUT | Timeout до завершения фазы `A` на стартовой → `failed`, fatal `2` (`timeout`); после частичного сбора — как было | 5.2 |
| §7.8 SCAN-PRIVATE-REQUEST-BLOCKED | `EgressPolicy` покрывает и `node:tls`/`net.Socket`; upstream получает `CONNECT <проверенный IP>:<port>`, `--proxy` только `http://`; сеть upstream — вне границы | 5.7 |
| §8 таблица гейта | Строка timeout до/после стартовой; `report-write-failed` с перезаписью JSON окончательным `exitCode`, JUnit/Summary в перечне; `--fail-on none` → «`0`; `2` при fatal или strict-причинах»; релевантность — статический максимум `variants` без кэпа confidence | 5.2 |
| §9 Q3 | Добавлены спорные строки ruleset: MAIL-02 `~all` при DMARC-enforcement → `info`; EMBED-02…05 `warning` при T1; TLS-02 относительный порог; CONSENT-01 `user-supplied` при `denied`; CONSENT-04 `no-choice-at-first-layer` | Вопрос 9 README |
| §9 Q7 | VG Hannover: дата 19.03.2025 подтверждена, открыты Berufung и деталь GTM; DSK Rn. 125 о первом уровне без возможности согласия; спайк egress до этапа 2 с приёмом `CONNECT` на IP-литерал; строка RFC 9989 удалена | errata №54, §7 №10, №31 |

### 1.3 Правки по линзе (право, тексты, минимизация)

| Раздел | Правка | Почему |
|---|---|---|
| §3.3, §3.6 «Правовой якорь» | VG Hannover 10 A 5385/22 — Urteil 19.03.2025 вписан как факт; ⚠ сужен до Berufung и детали GTM | Проверено модератором в 4б |
| §3.6 «Правовой якорь» | К ⚠ по DSK добавлена формулировка Rn. 125 о первом уровне без возможности согласия — она несёт вариант `no-choice-at-first-layer` | README §7 №10 |
| §3.5 текст CONSENT-03 | Утверждение о регионе переведено в «laut Nutzerangabe»: без оговорки текст заявлял бы факт местоположения, который сканер не проверял (риск § 824 BGB) | D11 |
| §3.3, §4 тексты CONSENT-01/05 | «Identifikatormerkmal» → «dauerhafte Kennung ({identifierKind}); der Wert wurde nicht gespeichert» — текст совпадает с условием `critical` и повторяет минимизацию | 5.3 |
| §6.2 текст HDR-02 | «Bei der … Cookie» → «Bei dem … Cookie» (грамматика; Cookie — das/der, не die) | Черновик de |
| §7.5 текст SCAN-THROTTLED | Число «drei» убрано: условие для браузера иное | D09 |

Стоп-слов и правовых выводов в немецких черновиках не найдено; все тексты сохраняют «beobachtet / gefunden / nicht gefunden», пометка «Entwurf — Prüfung durch Auftraggeber» сохранена. Выдуманных номеров дел, версий и лицензий не обнаружено: BGH I ZR 228/03, BGH I ZR 7/16, EuGH C-673/17 и C-40/17, LG München I 3 O 17493/20, OLG Köln 6 U 80/23, VG Hannover 10 A 5385/22, RFC 6066/7208/7489/8659/8996/9116/9989, BSI TR-02102-2 (2026-01), TR-03108-1, TR-03182, axe-core 4.14 (MPL-2.0), Lighthouse 13.x — совпадают с README. Плейсхолдеров «TBD»/«по необходимости» нет.

### 1.4 Пометки «предложение автора, не согласовано»

Все три группы (новые ключи сообщений, сценарии фикстур, распределение `SCAN-*` по этапам) консенсусу не противоречат, оставлены помеченными и присутствуют в Q6 и Q10. Добавленные мной ключи (`MAIL-01.legacy-pct`, `CONSENT-04.no-choice-at-first-layer`) попадают под ту же пометку. Никакого решения, противоречащего консенсусу, с этой пометкой в документе не было.

## 2. Расхождения с другими документами

Документы не редактировались. Состояние файлов — на момент правки 30.10.2026; часть из них параллельно правят другие редакторы раунда 6.

| Документ | Место | Проблема | Как должно быть по консенсусу |
|---|---|---|---|
| `docs/legal/wording-guide.md` | стр. 197, 457 | «§ 19 Abs. 4 S. 2 TDDDG» | «S. 3» (errata №51) |
| `docs/legal/wording-guide.md` | стр. 113, 128, 221, 501 | `{tStartMs} ms nach Navigation / Klick` | Относительное время вычисляется из монотонного `tMs` от навигации или действия (`navigationId`/`actionId`); поля `tStartMs` нет (5.3) |
| `docs/legal/wording-guide.md` | стр. 483–484, 491–492 | `TLS-02.expires-soon` / `expires-within-30-days` — абсолютные дни, нет `lifetimeDays`; только `{host}` | Относительный порог D19; текст «Restlaufzeit {days} Tage bei Gesamtlaufzeit {lifetimeDays} Tage»; для IP-цели «IP-Adresse {ip}» |
| `docs/legal/wording-guide.md` | стр. 221, 231 | `CONSENT-01.tracking-completed`: «enthielt eine Kennung ({identifierKind})» без привязки к устойчивости | «mit dauerhafter Kennung (Abgleich mit gespeichertem Cookie bzw. Speicher)»; для `per-load` — текст cookieless (errata §5.5 №6) |
| `docs/legal/wording-guide.md` | стр. 279, 292 | `CONSENT-04.blocking-no-reject` не фиксирует, что согласие на первом уровне возможно | Условие `acceptAvailableAtFirstLayer`; текст называет найденную Zustimmungsoption (errata §5.5 №7) |
| `docs/legal/wording-guide.md` | таблица CONSENT-04 | Нет `CONSENT-04.no-choice-at-first-layer` (`info`) | Добавить (D13, 4б) |
| `docs/legal/wording-guide.md` | стр. 501, 504 | Подтверждение отказа описано как «alle nicht notwendigen Kategorien `denied`, nach Neuladen bestätigt»; `reject-not-confirmed` без default-denied | Подтверждение — `origin: action` → `stored` + `decision.responded`; причина «nur Ausgangszustand des CMP» (errata №18) |
| `docs/legal/wording-guide.md` | стр. 408 | `MAIL-01.weak-option` смешивает `pct<100` и `t=y` | `pct` — отдельный legacy-вариант `info` «in RFC 9989 entfallen» (errata №55) |
| `docs/legal/wording-guide.md` | стр. 129 | Zustand `attempted / … / from-sw / from-cache` | Три поля `delivery` / `result` / `provenance` (errata §5.5 №2) |
| `docs/legal/wording-guide.md` ↔ `docs/03-checks.md` | ключи сообщений | Наборы ключей почти не пересекаются: wording-guide использует `CONSENT-01.tracking-completed`, `MAIL-01.policy-none`, `TLS-02.expires-soon`, `CONSENT-05.tracking-after-reject`, `PRIV-01.ambiguous-match` и т. д.; 03-checks — `CONSENT-01.hit-with-identifier`, `MAIL-01.monitoring-only`, `TLS-02.certificate-expiring`, `CONSENT-05.hit-after-reject`. Совпадают только `CONSENT-04.*` (частично), `PRIV-01.not-named`/`category-only`, `MAIL-01.record-not-found`, `TLS-02.certificate-invalid`, `EMBED-01.fonts-loaded`, `EMBED-02.maps-loaded` | Ключ `checkId.variant` (D22) должен быть одним реестром `variants` (Q10 «Все ID»); оба документа помечают ключи как предложение автора — выбрать реестр до этапа 1 (схема) |
| `docs/02-architecture.md` | стр. 245 | `locator.screenshot()` | `page.screenshot()` viewport до действий и обрезка по `box`; ≤ 50 % viewport, иначе `screenshot-skipped` (errata №34, №35) |
| `docs/02-architecture.md` | стр. 315, 1029 | `tStartMs`, `state (attempted / … / from-cache)` | `tMs`, `navigationId`, `actionId`, `frameId`, `parentRequestId`, `delivery`/`result`/`provenance`, `features` (errata №28) |
| `docs/02-architecture.md` | стр. 331 | Безопасные признаки `identifierPresent`, `eventType`, `consentState` | `features {identifier {kind, matchesStoredIdentifier}, eventType, consentSignal, parserVersion, observationSource}` (errata №16) |
| `docs/02-architecture.md` | стр. 237, 577, 595, 712, 805 | Контракт адаптера `extract, state, …, firstLayer, reject, accept, verify` | `extract / act / verify`, решение в `classifyFirstLayer` core (errata №13) |
| `docs/02-architecture.md` | стр. 788, 921, 958 | `observationId` | Связь через `evidence[].id`/`evidenceIds` (errata №27) |
| `docs/02-architecture.md` | стр. 378 | upstream `--proxy` «HTTP или SOCKS5» | Только `http://` (CONNECT); SOCKS5 — бэклог (5.7) |
| `docs/02-architecture.md` | стр. 87, 883, 1048, 1257 | `rulesetVersion` | Поле `ruleset.version` (5.6) |
| `docs/02-architecture.md` | стр. 114, 179, 192 | pnpm 11 | pnpm 12.16.1 (`packageManager`), фолбэк 11.28.9 (errata №57) |
| `docs/02-architecture.md` | стр. 1108, 1365 | `baseline migrate` в 1.0 | Бэклог; baseline с чужой `fingerprintVersion` → ошибка (errata №60) |
| `docs/04-quality-and-delivery.md` | стр. 103 | pnpm 11 | pnpm 12.16.1, фолбэк 11.28.9 |
| `docs/04-quality-and-delivery.md` | стр. 199 | `rulesetVersion` | `ruleset.version` |
| `docs/00-brief.md` | стр. 156 | «самая частая находка, 48 из 80» | «третья по частоте P0 (48/80; HDR-01 — 64, MAIL-01 — 54)» (errata №56) |
| `docs/prototype/BRIEF.md` | стр. 26 | Контракт адаптера `extract, state, …, verify` | `extract / act / verify` (README §2а) |
| `docs/adr/0004-pipeline-and-check-contract.md` | стр. 19 | `identifierPresent`, `eventType`, `consentState` | `features {…}` по 5.3 |
| `docs/adr/0008-fingerprint-suppressions-baseline.md` | стр. 21–22 | `baseline migrate` обязателен при смене `fingerprintVersion`; TRACK-01 по `observationId` | `baseline migrate` — бэклог; связь через `evidenceIds` |
| `docs/adr/0010-user-agent-and-bot-mode.md` | стр. 21 | `--proxy` «HTTP или SOCKS5, на все коллекторы» | Только HTTP CONNECT для браузера, undici и TLS; DNS напрямую |
| `docs/adr/0011-cmp-adapters.md` | стр. 18 | Контракт `extract, state, …, reject, accept, verify` | `extract / act / verify` |
| `docs/adr/0015-evidence-minimisation.md` | стр. 21, 25, 29 | `state`, `tStartMs`; `locator.screenshot()`; `identifierPresent` | `delivery`/`result`/`provenance`, `tMs`; снимок viewport и обрезка, правило 50 %; `features` |
| `docs/adr/0017-distribution.md`, `docs/adr/0018-toolchain-and-repository.md` | стр. 14; стр. 21, 45 | pnpm 11 | pnpm 12.16.1, фолбэк 11.28.9 |

## 3. Что осталось открытым

- **Вопросы заказчику** (README §8), от которых зависят строки документа: Q1 смысл `critical`; Q2 коды `0/1/2` и цена мягкого режима; Q3 UA; Q4 manifest и перенос CONSENT-05; Q6 `crmCode` для EMBED-03, CONSENT-06, TRACK-01 после принятия, FILE-01 «T0», политика `null`; Q9 подпись ruleset, включая новые строки (TLS-02 относительный порог, CONSENT-01 `user-supplied` при `denied`, CONSENT-04 `no-choice-at-first-layer`, MAIL-02 `~all` при DMARC-enforcement, EMBED-02…05 при T1); Q11 скриншоты и UrhG § 51; Q12 egress для доказательных аудитов (`critical` CONSENT-03 по заявлению пользователя — решение модератора вопреки Sol-К и Terra-К); Q13 стандарт описания сервисов PRIV-01; Q14 клиентские KEV и CVE примера Next.js 15.2.8; Q16 generic-селекторы DKIM против «перебора».
- **⚠ непроверенные факты**, сохранённые в документе: Rechtskraft OLG Köln 6 U 80/23 и Berufung VG Hannover 10 A 5385/22; деталь позиции VG Hannover о GTM; актуальность DSK OH Digitale Dienste и точные Rn. (74, 101, 123, 124–125; дословно Rn. 125 о первом уровне без возможности согласия); EDPB Guidelines 05/2020 Rn. 86 и Cookie Banner TF Type C; `p.typekit.net` как font-хост; `youtube-nocookie.com` и localStorage; формат `gcd` и наблюдаемость GTM template API; `impact` WPVulnerability; CDP-захват pagehide/keepalive/SW; sandbox на трёх входах ТЗ; приём upstream-прокси `CONNECT` на IP-литерал; mixed-content auto-upgrade и OOPIF; TLS 1.0/1.1-клиент в образе.
- **Внутри документа без решения** (Q10): численные пороги `coveredRatio` и комбинации признаков блокировки; признаки `origin: action` и `decision.responded` для каждого из семи адаптеров; каталог утверждений PRIV-02; MX/Null-MX-матрица MAIL-*; источник HSTS-preload; критерии заглушки и soft-404; достаточные признаки `exact` для VULN; уровни остальных состояний TLS-03 (`loaded`, `ws://`); доверенный валидатор DNS-01; контракт `PageProbe`; scope throttling и переходы статусов для `SCAN-*`; единый реестр `variants`/`messageId` — он же снимает расхождение ключей с wording-guide.
- **Пометки «предложение автора, не согласовано»** остаются на ключах сообщений (включая два добавленных), сценариях фикстур и распределении `SCAN-*` по этапам; все три вынесены в Q6 и Q10.
