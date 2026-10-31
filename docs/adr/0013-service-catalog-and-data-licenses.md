# ADR-0013 — Каталог сервисов, внешние наборы данных и их лицензии

Этот документ фиксирует, откуда сканер знает, что хост — «Google Analytics», cookie — трекинговая, а CNAME — маскировка, и какие лицензии допустимы в репозитории и образе Apache-2.0. Нужен разработке, заказчику (экспорт аудитов) и лицензионному ревью.

## Статус

`Accepted` — D14: единогласно по своему каталогу и fallback-источникам, большинство 3:1 за исключение EasyPrivacy (Fable-К — opt-in кэш); D17 единогласно (источники VULN). Дата: 2026-10-30.

## Контекст

- Проект Apache-2.0; ТЗ допускает «любой открытый источник с подходящей лицензией». Наиболее полные базы трекеров — DuckDuckGo Tracker Radar, Disconnect, Ghostery TrackerDB — под CC BY-NC-SA 4.0 и для open-source-инструмента, используемого в платных аудитах, не годятся. EasyPrivacy/EasyList — GPLv3 или CC BY-SA 3.0; Wappalyzer-форки — GPL-3.0.
- PRIV-01 (48/80 аудитов) нужен каталог с алиасами продукта и оператора по-немецки и по-английски и признаком, обязан ли сервис упоминаться в DSE.
- Модель получателя (D16) требует полей `provider`, `parent`, `dpfEntity`, а не «Empfänger: Google LLC (US)».
- Сборка каталога из чужих аудитов затрагивает § 87a UrhG (sui generis право на базы данных).

## Решение

- **Свой каталог** (Apache-2.0, около 100 записей) из экспорта собственных аудитов заказчика и документации вендоров; в PR — чек-лист § 87a UrhG. Поля: `serviceId`, `category`, `policyRelevance` (`required` / …), `provider {name, country}`, `parent`, `dpfEntity {name, listed, checkedAt, source}`, `domains`, `signatures` (URL, payload, initiator), `aliasesDe/En`, `categoryTerms`.
- **Fallback и вспомогательные наборы:** third-party-web 0.30.0 (MIT) — домен → сервис/категория; Open Cookie Database (Apache-2.0) — классификация cookies; AdGuard `cname-trackers` (MIT) — CNAME-cloaking; `tldts` (MIT; вшитый Public Suffix List — MPL-2.0) — eTLD+1. Всё вендорится и фиксируется в `datasets.lock.json` (имя, дата, sha256, лицензия, атрибуция).
- **VULN:** WPVulnerability (CC0) — ядро, плагины, темы WP; retire.js `jsrepository` (Apache-2.0) — JS-библиотеки; OSV/GHSA (GHSA — CC BY 4.0) с фильтром NC-источников — npm и Packagist; CISA KEV (CC0). Wordfence Intelligence и EUVD в MVP нет (условия не прочитаны, ⚠ проверить, факт 19).
- **Атрибуция.** Снапшоты лежат в `datasets[]` отчёта с датой, sha256, лицензией и `attribution` (для GHSA — CC BY 4.0). Атрибуции всех использованных в скане CC BY-источников выводятся в HTML-футере «Datensätze und Attribution»; лицензии и атрибуции всех распространяемых данных и зависимостей — в `THIRD_PARTY_NOTICES` npm-пакета и OCI-образа ([ADR-0017](0017-distribution.md)). L0-проверка лицензий сверяет файл с деревом зависимостей и `datasets.lock.json`.
- **Правовой контекст:** статический `data/legal/adequacy.json` — EWR, страновые решения с датами и сроками (UK до 27.12.2031), отдельно список организаций DPF; статус DPF (C-703/25 P pending) — только в `legalContext`.
- **Запрещено в MVP:** NC-, SA- и GPL-данные; EasyPrivacy/EasyList; Wappalyzer-данные; WPScan и Patchstack. Неизвестный хост — `unknown`, не трекер.
- **GeoIP** (DB-IP Lite, CC BY) — после релиза, opt-in `--network-attribution`; `processingLocation: "nicht feststellbar"` в 1.0.
- CI: лицензионный allowlist зависимостей и наборов данных; каждая находка несёт `classification {source, datasetVersion}`.

## Рассмотренные варианты

| Вариант | Плюс | Минус |
|---|---|---|
| Свой каталог + MIT/Apache/CC0 наборы (выбран) | Чистая лицензионная цепочка; алиасы под PRIV-01; модель provider/parent/dpfEntity | Каталог надо вести самим; около 100 записей на старте |
| Tracker Radar / Disconnect / Ghostery TrackerDB | Самые полные | CC BY-NC-SA — несовместимо с платными аудитами и Apache-2.0 |
| EasyPrivacy как opt-in кэш (Fable-К) | «Это трекер» с правилом как доказательством | CC BY-SA и лишний режим; отложено после релиза |
| Wappalyzer-форки для фингерпринта | Широкое покрытие технологий | GPL-3.0 данные; свой узкий детект WP/TYPO3/Joomla/Drupal/Shopware/Contao/Next.js достаточен |
| GeoIP как признак «передачи за пределы ЕС» | Наглядно | IP CDN не говорит о месте обработки; риск ложного правового вывода — только атрибут после релиза |

## Последствия

- Экспорт аудитов заказчика нужен на этапе 0 (вопрос 5): домены → сервисы → `crmCode` → фрагменты политик, только собственные данные.
- Вторая цепочка критического пути: экспорт → каталог → `derive` → PRIV-01.
- Обновление наборов — через `datasets.lock.json`; `datasets[]` в отчёте показывает дату, sha256 и атрибуцию каждого снапшота.
- Текст находки о третьей стороне: «Anbieter laut Dienstekatalog v[X]: … Ort der Verarbeitung und Übermittlungsinstrument wurden nicht geprüft.»

## Ссылки

- Консенсус: [D14, D16, D17](../consensus/README.md#2-итоговые-решения); [§3 D16](../consensus/README.md#3-подробности-по-спорным-точкам-и-точкам-изменённым-меньшинством); [§5.1, §5.8](../consensus/README.md#58-отчёты-csp-и-уведомления-о-лицензиях); ошибки 9, 64; факты 18–19; риск 12; вопрос 5; [errata №4, 50](../consensus/round-4/errata.md).
- Критика: [Fable-К §2.1–2.2, §4.2, §4.12](../consensus/round-3/claude-fable-5.1_critique.md), [Opus-К §4.11](../consensus/round-3/claude-opus-5.5_critique.md), [Sol-К D14, D17](../consensus/round-3/codex-gpt-6.1-sol_critique.md); [votes-matrix D14](../consensus/round-3/votes-matrix.md#d14).
- Предложения: [Opus-П §7](../consensus/round-2/claude-opus-5.5_proposal.md), [Fable-П §7](../consensus/round-2/claude-fable-5.1_proposal.md), [Sol-П §7](../consensus/round-2/codex-gpt-6.1-sol_proposal.md).
- Ресёрч: [data-sources-and-licenses §1, §5, §7–9](../01-research/data-sources-and-licenses.md); [legal-basis-map §5](../01-research/legal-basis-map.md); [prior-art §6–7](../01-research/prior-art.md).
