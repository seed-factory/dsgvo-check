# dsgvo-check — архитектурное предложение (раунд 2, Claude Opus 5.5)

Дата: 2026-10-30. Статус: проект решения, кода нет. Входные данные: `specs/*.md`, `docs/consensus/round-1/*.md`, `docs/01-research/*.md`. Пометка «⚠ проверить» — факт не подтверждён первоисточником в этой сессии. «Не согласен с ресёрчем» — место, где я сознательно расхожусь с раундом 1; сводка таких мест — в приложении А.

---

## 1. Позиционирование и границы

### 1.1 Одна фраза

**dsgvo-check — пассивный open-source CI-гейт (Apache-2.0) для немецких сайтов. Одной командой он фиксирует, что сайт делает до и после «Ablehnen», сверяет это с Datenschutzerklärung и Impressum, добавляет базовую гигиену TLS, заголовков и почты и выдаёт воспроизводимые наблюдения со стабильными ID и `crmCode`, без юридических выводов.**

Что значит `critical` в этом продукте: уверенно установленный технический факт, который утверждённая заказчиком политика (ruleset) считает приоритетным к устранению. Это не констатация нарушения закона.

### 1.2 Что входит в релиз (release manifest)

| Блок | Состав релиза 1.0 | Комментарий |
|---|---|---|
| Проверки P0 | Все 15: PRIV-01/02, CONSENT-01…04, TRACK-01, EMBED-01/02, MAIL-01/02, HDR-01, TLS-01/02, LEGAL-01 | Требование каталога. Каркас этапа 1 («первая проверка каждого модуля») выполнением P0 не считается |
| **CONSENT-05** | **Переносим в релиз** (P1 → обязательная часть) | Ядро идеи заказчика: «срабатывает ли Ablehnen и что меняется после отказа». Фаза «после отказа» всё равно нужна для проверки эффекта клика в CONSENT-04, поэтому стоимость CONSENT-05 — около 1,5 человеко-дня. Нужно согласие заказчика (решение К1) |
| P1 | CONSENT-06, EMBED-03/04/05, VULN-01/02, MAIL-03, TLS-03, TLS-04 — по плану этапа 3 | Если план съезжает, первыми уходят VULN-01/02 (самые дорогие) |
| P2 | В релиз только как opt-in и только при наличии буфера: SEC-01, LEGAL-02, HDR-02, DNS-01, FILE-01, ADMIN-01 | BFSG-01 и PERF-01 — после релиза, отдельными плагинами |
| Форматы | JSON (контракт), консоль, GitHub Job Summary, JUnit, **HTML**, **PDF** | HTML и PDF рендерятся из JSON отдельным шагом; это дёшево и закрывает идею заказчика (см. 1.4) |
| Дистрибуция | Docker-образ, GitHub Action, GitLab-компонент и шаблон, npm-пакет | По ТЗ |

### 1.3 Что сознательно не делаем

| Не делаем | Почему |
|---|---|
| Правовую оценку конкретного сайта («verstößt», «unzulässig», «konform») и любые генерируемые под сайт правовые тексты, в том числе через LLM | ТЗ, RDG (логика BGH Smartlaw), § 824 BGB |
| Активные проверки: перебор путей и параметров, инъекции, попытки входа, отправку форм, вызовы XML-RPC, обход CAPTCHA, WAF и bot-блоков, stealth-маскировку браузера | ТЗ, §§ 202a/202c StGB, BGH I ZR 224/12 |
| Оценку server-side передачи (Meta CAPI, Measurement Protocol, пересылку из sGTM) | Из браузера не наблюдаема. В отчёте пишем об этом прямо |
| Отдельную проверку «передача в третьи страны» и вывод о законности по стране | См. 1.4 и раздел 7 |
| Австрию и Швейцарию (DSG, nDSG), не-немецкие правовые профили | Фокус продукта. Технически сканер работает на любом сайте |
| Глубокий разбор TCF и GPP, оценку Pay-or-Okay, AI Act Art. 50 (чат-боты) | Вне каталога. TCF только читаем (`__tcfapi('ping')`) как сигнал |
| Batch-режим «много сайтов», историю и сравнение аудитов | После релиза (`--targets`). В MVP один URL на запуск |
| Firefox и WebKit, официальную поддержку npm-режима на Windows и macOS | Эталон — Chromium. Windows и macOS — best effort |
| SARIF и GitLab Code Quality | Оба формата требуют путь к файлу и номер строки, у веб-находки их нет |
| PDF/A, подпись отчёта | После релиза. В MVP хэш снимка и отчёта (раздел 8) |
| Автоматическую отправку чего-либо владельцам сайтов, генератор претензий, публичные рейтинги | Анти-абмахн-дизайн |
| Публичный хостинг сканера как сервиса | Другой продукт с другой правовой нагрузкой |

### 1.4 Как разрешаю расхождения идеи и ТЗ

| Расхождение | Решение |
|---|---|
| Идея: «отчёт HTML/PDF». ТЗ: HTML «если успеешь», PDF не упомянут | HTML и PDF входят в релиз как рендер из JSON (`dsgvo-check report report.json --format html,pdf`). PDF — `page.pdf()` того же HTML в офлайн-контексте Chromium, который у нас уже есть. Стоимость HTML около 3,5, PDF около 1 человеко-дня. Тексты отчёта от заказчика вставляются без пересканирования |
| Идея: «код возврата для CI (опционально)». ТЗ: коды `0/1/2` обязательны | Коды реализуются всегда. «Опционально» трактую как режим «только отчёт»: `--fail-on none` никогда не даёт `1`, но `2` при сбое сканера остаётся |
| FILE-01: в ядре идеи (`.git`, `.env`, бэкапы), но P2 в каталоге и 0 находок в 80 аудитах | Не блокирует релиз. Реализуется как **opt-in** класса «exposure» (`--exposure-probes`): около 15 фиксированных путей, сигнатуры, лимит 4 KiB, тело не сохраняется. В релиз попадает при наличии буфера, иначе первым после релиза. Уровня `T0` в контракте нет: подтверждённый секрет даёт `critical`, `crmCode` задаёт заказчик |
| «Передача за пределы ЕС» есть в идее, проверки в каталоге нет | Не вводим `TRANSFER-01`. Каждая находка о стороннем сервисе несёт атрибут `recipient` из нашего каталога (компания, страна головной организации, DPF-статус с датой проверки) и, по флагу `--network-attribution`, атрибут `network` (IP, ASN, страна IP по DB-IP). Страна на уровень находки не влияет. Статус DPF — версионируемые данные, а не код |
| Стек: идея фиксирует TypeScript + Playwright, ТЗ разрешает любой | Считаем стек зафиксированным. Эталонный движок — Chromium (Chrome for Testing) |
| ТЗ требует `crmCode` в каждой находке, а у P2 в каталоге его нет; у EMBED-03 код карт; у FILE-01 тир T0 | `crmCode: string \| null`. `null` допустим только там, где маппинг не утверждён, и для диагностических вариантов. Маппинг — данные (`data/crm/mapping.yaml`), утверждает заказчик (решение К13) |
| Идея: «Impressum и Datenschutz доступны с каждой страницы», а сканер обходит выборку | Утверждаем только про проверенные страницы: «auf n von m geprüften Seiten». Состав выборки — в отчёте о покрытии |
| Тиры `crmCode` (T0/T1/T3) и уровни ТЗ (`critical/warning/info`) | Это разные оси. Тир — категория CRM заказчика, уровень — политика гейтинга. Связь задаёт ruleset, а не префикс кода |

---

## 2. Архитектура

### 2.1 Принципы

1. **Наблюдение отделено от оценки.** Сначала сбор артефактов, затем неизменяемый снимок, затем чистые проверки, которые выдают наблюдения без уровня, затем оценка по ruleset-данным, затем гейт, затем репортеры. Право меняется чаще, чем детект: решение суда меняет YAML, а не код проверки.
2. **Проверки не делают I/O.** Если проверке нужны дополнительные запросы (FILE-01, `readme.txt` плагина), она описывает их декларативно (`ProbeSpec`). Коллектор выполняет их под единой политикой пассивности. Новая проверка физически не может стать «активной» в обход политики.
3. **Снимок воспроизводим.** `--save-artifacts` сохраняет очищенный снимок, `--from-artifacts` пересобирает отчёт без сети. Отсюда же берутся L1-фикстуры.
4. **Неизвестное — это класс, а не «чисто».** У каждой проверки есть статус покрытия; `inconclusive` не равно `completed`.
5. **Весь исходящий трафик браузера идёт через собственный egress-прокси сканера.** Это одна точка для SSRF-защиты, журнала соединений, upstream-прокси (ЕС-выход) и подмены DNS в тестах.

### 2.2 Модули

| Модуль | Ответственность | Зависит от |
|---|---|---|
| `cli` | Аргументы (commander), конфиг `.dsgvo-check.yaml` (zod), подкоманды `scan`, `report`, `baseline`, `install`, `update`, `explain` | `core` |
| `core/engine` | План скана: выбранные проверки → нужные разделы снимка и пробы → коллекторы. Стадии сбора, таймауты, отмена | `core/api`, реестр снаружи |
| `core/api` | Типы `Snapshot`, `CheckDefinition`, `Observation`, `Evidence`, `ProbeSpec`. Единственное, что импортируют проверки | — |
| `core/assess` | Оценка по ruleset: `severity`, `crmCode`, `gating`, кэп уверенности, профили (`de-2026`, позже `de-strict`, `bfsg`, `eu-omnibus-preview`) | `data/ruleset`, `data/crm` |
| `core/gate` | Подавления, baseline, порог, код возврата, `exitReason` | — |
| `net/egress-proxy` | Локальный HTTP/CONNECT-прокси для Chromium: резолв один раз, проверка IP (private, loopback, link-local, IMDS), журнал соединений с реальным IP, цепочка на upstream `--proxy`. В тестах — подмена резолвера на фикстуры | `net/resolver` |
| `net/resolver` | Общий DNS-резолвер (инжектируемый) и IP-политика для прокси, HTTP- и TLS-клиентов | `node:dns`, `dns-packet` |
| `collectors/browser` | Playwright: фазы A, A′, B, C, M; события сети, cookies, хранилища, DOM-факты, документы, consent-сигналы, CDP (`Audits`, initiator) | `playwright-core`, `cmp/*` |
| `collectors/browser/cmp` | Реестр CMP-адаптеров и общая эвристика баннера | `data/cmp` |
| `collectors/http` | undici-клиент с вежливостью: редирект-цепочки TLS-01, `security.txt`, цели ссылок LEGAL-01, исполнение `ProbeSpec` | `net/*` |
| `collectors/tls` | Handshake и цепочка (TLS-02), пробы TLS 1.0/1.1 (TLS-04) | `node:tls` |
| `collectors/dns` | MX, SPF, DMARC tree walk, DKIM, CAA, DS | `net/resolver` |
| `derive` | Чистые функции поверх снимка: классификация хостов (каталог сервисов), фингерпринты CMS и библиотек, извлечение и нормализация текста политики. Результат кладётся в снимок до запуска проверок | `data/*` |
| `checks/<ID>` | Одна папка — одна проверка: определение, фикстуры, тесты, страница документации | только `core/api` |
| `report/*` | `json`, `console`, `gh-summary`, `junit`, `html` (Preact SSR, без JS), `pdf` | `data/texts` |
| `datasets` | Менеджер снапшотов внешних данных (KEV, retire.js, EasyList и т. п.): манифест, лицензия, дата, sha256, `update`, `--offline` | — |

Правила зависимостей проверяются тестом графа импортов: `core` не импортирует ни проверки, ни коллекторы; проверки не импортируют Playwright и `node:*` I/O.

### 2.3 Поток данных

```text
URL + опции ─► Engine.plan ──► Stage 1: DNS · TLS · HTTP-база · Browser(A → A′ → B → C → M)
                                   │            (весь трафик браузера ─► egress-proxy ─► Internet / upstream EU-proxy)
                                   ▼
                     derive: классификация хостов, фингерпринты, тексты DSE/Impressum
                                   ▼
               Stage 2: ProbeSpec из checks.planProbes(снимок) ─► collectors/http (политика пассивности)
                                   ▼
             Snapshot (неизменяемый, версионированный, уже очищенный) ─► sha256 ─► [--save-artifacts]
                                   ▼
             checks/*.run(snapshot) → CheckOutput{status, coverage, observations}   (чисто, без I/O)
                                   ▼
             assess(ruleset, profile, user overrides) → Finding{severity, crmCode, confidence}
                                   ▼
             gate: suppress → baseline → threshold → exitCode/exitReason
                                   ▼
             reporters: JSON │ console │ gh-summary │ JUnit │ HTML → PDF
```

### 2.4 Интерфейс проверки

```ts
// core/api.ts — иллюстрация контракта, не финальный код
export type Phase = 'preConsent' | 'preConsentInteraction' | 'postReject' | 'postAccept' | 'mobileFirstLayer';
export type Confidence = 'high' | 'medium' | 'low';
// 'skipped' и 'error' ставит движок, а не проверка
export type CheckStatus = 'completed' | 'partial' | 'inconclusive' | 'not_applicable';

export interface CheckDefinition<K extends SnapshotKey = SnapshotKey> {
  id: CheckId;                        // 'CONSENT-04' — публичный контракт, не переиспользуется
  logicVersion: string;               // semver логики детекта, попадает в отчёт
  module: 'browser' | 'http' | 'tls' | 'dns';
  requires: readonly K[];             // разделы снимка; движок поднимет только нужные коллекторы
  owns?: readonly ServiceCategory[];  // категории сервисов, которыми владеет проверка (раздел 6.1)
  planProbes?(s: Readonly<Partial<Snapshot>>): ProbeSpec[];          // декларативные доп. запросы
  run(s: Readonly<Pick<Snapshot, K>>, ctx: CheckContext): CheckOutput; // чистая и синхронная
}

export interface CheckOutput {
  status: CheckStatus;
  reason?: string;                    // 'banner-not-recognized' | 'policy-not-found' | ...
  coverage?: Coverage;                // что проверено: страницы, документы, селекторы DKIM
  observations: Observation[];        // факт + классификация + уверенность, без severity
}

export interface Observation {
  variant: string;                    // 'hit-with-identifier' | 'blocking-no-reject' | ...
  subject: { kind: SubjectKind; id: string; label?: string };  // основа fingerprint
  phase?: Phase;
  pages: string[];
  classification?: { category: string; source: DatasetRef; confidence: Confidence };
  confidence: Confidence;
  evidence: EvidenceId[];             // ссылки в EvidenceStore снимка
  params: Record<string, string | number | boolean>;          // плейсхолдеры ICU-сообщений
  serviceId?: string;                 // группировка в отчёте и подавление по сервису
}

export interface ProbeSpec {          // проверка описывает запрос, коллектор его исполняет
  class: 'technical' | 'exposure';    // класс пассивности (раздел 11.1)
  method: 'GET';
  path: string;
  maxBytes: number;                   // для exposure не больше 4096, не отключается
  followRedirects: 0 | 1 | 5;
  signatureId?: string;               // FILE-01: тело наружу не отдаётся, только факт совпадения
}
```

`Snapshot` (сокращённо): `meta` (версии, окружение, UA, egress, профиль, тайминги), `pages`, `network` (запросы и ответы из `context.on`, CDP-initiator, журнал egress-прокси), `storage` (cookies, localStorage, sessionStorage, имена IndexedDB по фазам), `dom` (ссылки, формы, iframes, `link rel`, mixed-content-issues), `cmp` (адаптер, первый уровень, клики, verify, гео- и бот-сигналы), `consentSignals` (`dataLayer` consent default/update, `gcs`/`gcd` по хитам), `documents` (текст Impressum и DSE, хэши), `http`, `tls`, `dns`, `components` (CMS, плагины, JS-библиотеки с версиями и уверенностью), `evidence` (нормализованные и уже отредактированные доказательства).

### 2.5 Как добавляется новая проверка без правок ядра

1. Папка `src/checks/<id>/`: `index.ts` (`defineCheck`), `fixtures/{violation,clean}.snapshot.json` (+ `inconclusive` для рискованных), при необходимости L2-сайт `fixtures/site/`, тесты, `docs.md`.
2. Одна строка в `src/checks/index.ts`. Это слой проверок, не ядро; явный список типобезопасен и виден в PR.
3. Тексты `de` и `en` в `data/texts/*.yaml`, политика уровней в `data/ruleset/*.yaml`, `crmCode` в `data/crm/mapping.yaml`, при необходимости категория в `data/routing.yaml`.
4. **Тест полноты реестра** падает, если чего-то нет: фикстур нарушения и чистой, ключей сообщений на двух языках, записи ruleset, решения по `crmCode` (код или явный `null` с причиной), страницы документации; ID уникален и есть в каталоге или в списке внекаталожных.
5. Новый CMP — это адаптер в `collectors/browser/cmp/<id>.ts`, данные `data/cmp/<id>.yaml`, строка в реестре адаптеров и фикстура-симулятор.

Автозагрузку плагинов из `node_modules` не делаем. Внешние плагины (BFSG-01, PERF-01) после релиза подключаются только явно, через `--plugin <pkg>` с проверкой `apiVersion`.

### 2.6 Где живут данные

```text
packages/dsgvo-check/data/            # YAML-источники; при сборке валидируются zod и компилируются в JSON
├─ services/*.yaml        # каталог сервисов: домены, вендор, компания, hqCountry, dpf, категория, алиасы для DSE, cookie-паттерны
├─ routing.yaml           # категория сервиса → проверка-владелец (раздел 6.1)
├─ cookies/allowlist.yaml # технически необходимые cookie и ключи хранилищ (CMP, сессии, LB, CSRF, язык)
├─ cmp/<id>.yaml          # семантика 7 CMP: детект, селекторы первого уровня, подписи, чтение состояния, гео- и бот-сигналы
├─ cmp/lexicon.yaml       # словарь кнопок de/en: reject | accept | settings | save | close-ambiguous | pur-abo
├─ privacy/categories.yaml# категорийные термины для PRIV-01 и policyRelevance категорий
├─ privacy/claims.yaml    # проверяемые утверждения для PRIV-02
├─ legal02/patterns.yaml  # устаревшие нормы с validFrom
├─ ruleset/de-2026.yaml   # уровни по вариантам, gating, maxSeverity, кэп уверенности; CalVer rulesetVersion
├─ crm/mapping.yaml       # checkId/variant → crmCode (утверждает заказчик)
├─ texts/{de,en}.yaml     # ICU MF1: title/summary/description/remediation/legalNote по checkId.variant, дисклеймер
├─ legal/context.yaml     # «Rechtlicher Kontext»: DPF, Omnibus, версии DSK/EDPB/BSI c verifiedAt и reviewBy
├─ fingerprints/*.yaml    # собственные отпечатки CMS и плагинов (Apache-2.0)
├─ dkim/providers.yaml    # MX-паттерн → селекторы, confirmed: true/false
├─ files/paths.yaml       # FILE-01: путь, сигнатура, уровень
└─ datasets.lock.json     # манифест вендоренных снапшотов: источник, лицензия, дата, sha256
```

`CODEOWNERS`: `texts/de.yaml`, `legal/*`, `ruleset/*`, `crm/*` ревьюит заказчик. Остальные данные ревьюит разработка. Скачиваемые наборы (EasyList, DB-IP, Wordfence) хранятся только в кэше пользователя `~/.cache/dsgvo-check/` или в слое Docker-образа с атрибуцией и никогда не смешиваются с нашими Apache-2.0-файлами.

### 2.7 Репозиторий и тулчейн

- pnpm-workspace: один публикуемый пакет плюс приватные `fixture-server` и `test-utils`. `action.yml` в корне; отдельные репозитории для примера «красной» сборки, GitLab-компонента и **приватной** канарейки.
- Node: **`engines >= 24`**, образ и Action на Node 24, CI-матрица 24 и 26. Не согласен с ресёрчем engineering (`>=22.12`): undici 8 требует `>=22.19`, а Node 22 уходит в EOL 30.04.2027, через полгода после релиза. Это вынудило бы к мажорному релизу ради одного `engines`.
- TypeScript 7.0 (`tsc` для typecheck и emit, `isolatedDeclarations`; полноту `.d.ts` ⚠ проверить, запасной вариант — tsdown). pnpm 11. Vitest 5. Biome 2.6 плюс oxlint-tsgolint для правил про промисы. zod 4 → JSON Schema 2020-12, Ajv 8 в контрактных тестах. commander 15. undici 8. `playwright-core@1.64.1` с точным пином. Бандлер не нужен.

---

## 3. Жизненный цикл скана и фазы согласия

### 3.1 Последовательность

| Шаг | Что происходит | Запросы к сайту |
|---|---|---|
| 0. Preflight | Валидация URL (только `http(s)`, без credentials в URL); резолв; цель публичная или приватная (приватная — только с `--allow-private`); старт egress-прокси; `robots.txt` | 1 |
| 1. Не-браузерные коллекторы, параллельно браузеру и с общей квотой вежливости | DNS: MX, SPF, DMARC tree walk, DKIM ≤ 25 селекторов, CAA, DS. TLS: handshake 443 для хоста (и www или apex, если используется), пробы TLS 1.0 и 1.1. HTTP: `http://` цепочки для хоста, apex и www; `/.well-known/security.txt` | около 10 HTTP и 3–5 TLS |
| 2. Фаза A | Свежий профиль, страницы по одной (3.3), без взаимодействия, окно тишины (3.4). После окна: чтение CMP (адаптеры, только чтение), первый уровень баннера, DOM-факты, тексты Impressum и DSE | 6 навигаций |
| 3. Фаза A′ | Тот же профиль, стартовая и Kontakt: `mouse.move`, `mouse.wheel(0, 400)`, `keyboard.press('Shift')`, без кликов; окно тишины | 2 |
| 4. Фаза B | Свежий профиль: стартовая → ожидание баннера и минимум 4 с → первый уровень → клик «Ablehnen» (или путь через настройки с пометкой) → верификация → reload → 2 страницы | 4 |
| 5. Фаза C | Свежий профиль: стартовая → «Alle akzeptieren» → 2 страницы с наибольшим числом сторонних сервисов в A | 3 |
| 6. Фаза M | Свежий профиль, мобильная эмуляция 390×844: только стартовая, первый уровень и блокировка, без кликов | 1 |
| 7. Stage 2 probes | `ProbeSpec` проверок: `readme.txt` и `style.css` обнаруженных плагинов и тем (cap 20), WordPress `readme.html` или `feed`; exposure-пробы только с флагом | 0–25 |
| 8. Финал | Закрыть браузеры, собрать и очистить снимок, sha256, проверки, оценка, гейт, отчёты | — |

Фазы идут **последовательно** (вежливость и стабильность измерений). Параллельно им работают только DNS, TLS и HTTP-пробы с общей квотой на хост.

### 3.2 Браузерные контексты

| Фаза | Профиль | Viewport | Что даёт |
|---|---|---|---|
| A — до согласия | Новый `launchPersistentContext(<tmp>)` | 1440×900 | CONSENT-01/02/03, TRACK-01, EMBED-*, LEGAL-01, TLS-03, HDR-01 (ответы документов), Consent Mode default, тексты документов, скрипты для VULN |
| A′ — нейтральная интерактивность | Тот же, что A | то же | Delay-JS (WP Rocket и аналоги), Borlabs «баннер после взаимодействия», lazy-embeds. Находки помечаются `trigger: interaction-without-consent` |
| B — после отказа | Новый | 1440×900 | CONSENT-04 (клик, верификация), CONSENT-05, CONSENT-06 (update), второе независимое окно «до клика» на стартовой (репликация, 3.4) |
| C — после принятия | Новый | 1440×900 | Инвентарь сервисов для PRIV-01/02, положительный контроль для CONSENT-05/06 |
| M — мобильный первый уровень | Новый, `isMobile`, `hasTouch` | 390×844 | Блокирует ли баннер на мобильном, кнопки первого уровня (DSK Rn. 124 требует смотреть и mobile) |

- **Свежий persistent-профиль на фазу, а не `newContext()`.** Эксперимент раунда 1 показал, что `newContext()` ведёт себя как Incognito как минимум по preconnect. Не согласен с ресёрчем engineering (`newContext` на скан): мы измеряем поведение для обычного посетителя. Цена — около 1 с на запуск браузера в каждой фазе. Финально подтвердить замером на этапе 0 (спайк С2); запасной режим — `--profile-mode incognito` с пометкой в «Messumgebung».
- Движок: Chrome for Testing в режиме new headless (`channel: 'chromium'`), а не headless shell: shell выдаёт `HeadlessChrome` в `Sec-CH-UA` даже после подмены UA.
- Перехват: `context.on('request' | 'response' | 'requestfinished' | 'requestfailed')` с подпиской до первой навигации; CDP добавочно (`Network.requestWillBeSent.initiator`, `responseReceivedExtraInfo.blockedCookies`, `Audits.issueAdded`); `page.route` для наблюдения не используем, потому что он отключает HTTP-кэш.
- Хук записи cookies: init-скрипт оборачивает сеттеры `document.cookie` и `CookieStore` только для наблюдения (имя, домен, стек вызова), значение не логируется.
- Пробел «beacon на `pagehide`» (Playwright его не видит) частично закрывает журнал egress-прокси (новые CONNECT к трекер-хостам после отказа). Сработает ли CDP-сессия уровня браузера для таких запросов ⚠ проверить; NetLog — опция `--netlog` (P1).

### 3.3 Сколько страниц и как выбирать

По умолчанию **6 страниц в фазе A** (`--max-pages`; `--quick` = стартовая и обе правовые страницы без C и M; `--thorough` = 15):

1. Стартовый URL после редиректов (цепочка — evidence для TLS-01).
2. Impressum и Datenschutzerklärung по ссылкам со стартовой (раздел 6, LEGAL-01).
3. Kontakt, Anfahrt или Standort — самые вероятные места для Maps (EMBED-02) и reCAPTCHA (EMBED-04).
4. До двух страниц по ключевым словам навигации и подвала (`video`, `über uns`, `team`, `karriere`, `blog`, `referenzen`, `bewertungen`, `termin`, `shop`, `newsletter`) и по DOM-сигналам стартовой (iframes, `youtube`, `maps`). Если ссылок мало, берём sitemap (`robots.txt` → `Sitemap:`, `/sitemap.xml`, `/wp-sitemap.xml`) и выбираем **разные шаблоны** по первому сегменту пути.

Исключения: `mailto:`, `tel:`, `javascript:`, файлы, `wp-admin`, `wp-login.php`, корзина, checkout, поиск, logout. Область обхода — хост цели и пара www/apex. Остальные поддомены того же eTLD+1 не обходим, их запросы классифицируются как first-party. `robots.txt`: стартовая и правовые страницы проверяются всегда (это проверка одного сайта, а не индексация); для дополнительных страниц соблюдаем `Disallow` для `*` и нашего токена; `--ignore-robots` — явная опция.

### 3.4 Ожидание «тишины» сети

`networkidle` не используем (Playwright помечает его DISCOURAGED). Алгоритм из ресёрча browser-automation §1.4:

```text
goto(url, waitUntil='domcontentloaded', timeout=30s); wait 'load' ≤ 15s (не фатально → pageLoadIncomplete)
loop: inflight = started − finished − failed   (без websocket, eventsource, media-range)
      quiet = (now − lastRequestStart ≥ 2s) && inflight ≤ 1
      break if (now − t0 ≥ MIN_DWELL && quiet) or (now − t0 ≥ HARD_CAP → quietNotReached=true)
A: MIN_DWELL 6s / HARD_CAP 20s · A′: 3s / 10s · B и C: 4s / 12s · M: 3s / 8s
```

Параметры — данные конфигурации, калибруются на корпусе (этап 0–3). `page.clock` не включаем.

**Репликация вместо повторов.** В фазе B до клика стартовая открывается в новом профиле и наблюдается минимум 4 с. Это второе независимое измерение «до согласия». Если хит трекера появился в A в первые 4 с, а в B до клика его нет, находка получает `replicated: false` и уверенность `medium` (кэп уровня — `warning`). Так мы гасим A/B-тесты и ротацию рекламы без дополнительных навигаций.

### 3.5 Бюджет времени

| Часть | Оценка |
|---|---|
| A: 6 страниц × (загрузка + 6–20 с) + паузы | 1,5–2,5 мин |
| A′ | ≈ 20 с |
| B | ≈ 45 с |
| C | ≈ 30 с |
| M | ≈ 15 с |
| Stage 2 probes (≤ 2 запр./с) | 5–15 с |
| DNS, TLS, HTTP (параллельно браузеру) | не на критическом пути |
| **Итого типично** | **3–4 мин**; жёсткий потолок `--timeout 8m`; в шаблонах CI `timeout-minutes: 15` |

### 3.6 Вежливость (rate limiting)

| Параметр | Значение |
|---|---|
| Навигации | Строго по одной на хост, пауза ≥ 1,5 с (`--delay`) |
| HTTP-пробы сканера | Token bucket ≤ 2 запр./с на хост, конкуррентность 2, лимит тела 2 MiB для HTML, 64 KiB для `readme.txt`, 4 KiB для exposure |
| DNS | Конкуррентность 8, таймаут 3 с, 1 повтор; общий бюджет ≤ 60 запросов |
| TLS | ≤ 5 handshake на скан |
| 429 и 503 | Соблюдаем `Retry-After`; после 3 подряд пробы останавливаются, диагностика `SCAN-THROTTLED` |
| Ретраи | 1 на сетевую ошибку для навигации стартовой и HTTP-проб (кроме exposure); 4xx не повторяем |
| Прозрачность | Счётчик собственных запросов (навигации, пробы, DNS, TLS) в отчёте; `--dry-run` печатает план без выполнения |

Подзагрузки браузера (скрипты, картинки сайта) не троттлим: это обычный визит.

### 3.7 User-Agent

Требование ТЗ — честный UA со ссылкой на репозиторий. Ресёрч показал конфликт: строку `… Chrome/156… dsgvo-check/0.1 (+https://github.com/…)` распознают как бота `isbot` (паттерны `http`, `\.com\b`, `check\b`) и встроенная в Real Cookie Banner копия этой регулярки, а RCB по умолчанию для ботов «принимает всё». Само имя `dsgvo-check` попадает под `check\b`. Мы получили бы ложные CONSENT-01/02/03 у чистых сайтов.

Предложение (решение К2 за заказчиком):

| Канал | UA |
|---|---|
| HTTP-, TLS-пробы и DNS (их CMP не видят) | `<product>/<ver> (+https://github.com/<org>/<repo>; passive DSGVO/security check)` — полная ссылка на репозиторий |
| Браузер | Реальный Chrome UA с версией движка из `browser.version()` (без `HeadlessChrome`) плюс токен `<product>/<ver> (+<project-domain>/scanner)`. Токен и домен обязаны проходить CI-тест против закреплённой версии `isbot` и извлечённых регулярок RCB, Borlabs, Complianz, Cookiebot, Usercentrics. По ссылке страница «что делает сканер» со ссылкой на репозиторий |

Следствие: **имя продукта нужно выбрать до этапа 1 так, чтобы токен проходил бот-тест** (решение К2). Если заказчик настаивает на буквальной GitHub-ссылке в браузерном UA, работаем в режиме (а) из ресёрча: детектор бот-режима обязателен, сайты на RCB будут давать `inconclusive`. `From:` по умолчанию не отправляем (только `--contact <email>`), `DNT` и `Sec-GPC` не отправляем: RCB и Borlabs при DNT решают сами, и мы получили бы ложное «баннера нет».

### 3.8 Гео

GitLab.com hosted runners по умолчанию в `us-east1`; регион GitHub-hosted раннеров не документирован ⚠. Cookiebot, Usercentrics и Complianz вне ЕС не показывают баннер или «принимают всё».

1. **Всегда читаем гео-сигналы CMP**: `CookieConsent=-1` и `Cookiebot.isOutOfRegion`, `__ucCmp.isConsentRequired()`, `complianz.region` и классы `cmplz-us|other`, Borlabs `dialogGeoIpActive` с ответом `visible:false`, `__tcfapi('ping').gdprApplies`, `region` в Consent Mode default.
2. Сигнал найден → затронутые наблюдения фазы A (CONSENT-01…03, TRACK-01, EMBED-*) получают статус `inconclusive`, в `diagnostics` уходит `SCAN-GEO` с объяснением. CONSENT-03 и CONSENT-04 в этом случае не выдаются.
3. `--proxy <url>` (HTTP или SOCKS5) — ЕС-выход; локальный egress-прокси цепляется к нему. В README и в Action — инструкция для self-hosted runner в ЕС.
4. `scan.environment.egress`: `mode` (`direct`/`proxy`), `region` (`unverified` / `eu-asserted` через `--assume-region eu` / `eu-inferred` по гео-ответам CMP, если они это раскрывают ⚠). Сторонний «what is my IP» по умолчанию не вызываем: лишняя передача данных.
5. CONSENT-03 даёт `critical` только если CMP-скрипта на странице нет вовсе (гео-таргетинг невозможен) или egress в ЕС подтверждён; иначе максимум `warning` с текстом «Messstandort nicht in der EU verifiziert».

### 3.9 Бот-режим CMP и анти-бот сайтов

- **Детектор бот-режима обязателен независимо от UA**: Cookiebot `isSpider()`/`isOutOfRegion`; Complianz при `region=eu` даёт `cmplz_has_consent('marketing') === true` без consent-cookie; consent-cookie RCB (`real_cookie_banner*`) или Borlabs (`borlabs-cookie`) появилась в фазе A без нашего клика с полным набором согласий; общий признак — consent-cookie любой CMP в фазе A без взаимодействия. Следствие то же, что у гео: `inconclusive` плюс `SCAN-BOTMODE` в `diagnostics`. **Не согласен с ресёрчем browser-automation** (понижать до `warning`): `warning` всё ещё роняет `--fail-on warning`, хотя измерение недостоверно.
- **Анти-бот сайта**: 403, 429 или страница-челлендж на стартовой (Cloudflare `cf-mitigated: challenge`, заголовок «Just a moment…», DataDome, Akamai) → `SCAN-BLOCKED`, скан не выполнен, код `2`. Никаких обходов.

### 3.10 «Messumgebung» в отчёте

Обязательный раздел: UA, движок и версия, режим headless, sandbox, тип профиля, locale `de-DE`, timezone `Europe/Berlin`, viewport, egress, отключённые Playwright фичи Chromium (`ThirdPartyStoragePartitioning`, `HttpsUpgrades`), QUIC выключен из-за прокси, сторонние cookies разрешены, `navigator.webdriver=true`, без расширений и adblock, известные пробелы наблюдения (beacons на выгрузке, server-side передача). Нужен и аудитору, и как защита по § 824 BGB (проверяемая методика).

---

## 4. Баннеры и CMP

### 4.1 Контракт адаптера

```ts
// collectors/browser/cmp/types.ts — иллюстрация
export interface CmpAdapter {
  id: 'borlabs' | 'cookiebot' | 'complianz' | 'usercentrics' | 'ccm19' | 'real-cookie-banner' | 'cookiehub';
  detect(page: Page): Promise<{ present: boolean; version?: string; confidence: Confidence }>; // скрипт, глобал, DOM
  state(page: Page): Promise<CmpState>;            // JS-API или consent-cookie, только чтение
  geoSignals(page: Page): Promise<Signal[]>;
  botSignals(page: Page): Promise<Signal[]>;
  firstLayer(page: Page): Promise<FirstLayer>;     // контейнер, кнопки {role,label,kind,box,visible,actionable,contrast}, blocking
  reject(page: Page): Promise<ClickResult>;        // только реальный UI первого уровня; путь через настройки → флаг viaSettings
  accept(page: Page): Promise<ClickResult>;
  verifyRejected(page: Page): Promise<{ uiClosed: boolean; stateDenied: boolean; cookieDenied: boolean; persistedAfterReload: boolean }>;
}
```

Правила: JS-API CMP только читаем, никаких `Cookiebot.withdraw()` или `denyAll()`; клик только `locator.click()` без `force`, actionability Playwright и есть проверка «кнопка доступна человеку»; перекрытие кнопки — доказательство для CONSENT-04, а не повод кликать скриптом; селекторы только CSS и role (XPath не пробивает shadow DOM).

### 4.2 Семь CMP каталога (порядок реализации — по каталогу)

| # | CMP | Детект | Первый уровень и «Ablehnen» | Состояние | Гео- и бот-сигналы, особенности |
|---|---|---|---|---|---|
| 1 | Borlabs v3 / v2 | `window.BorlabsCookie`, `borlabsCookieConfig`; DOM `#BorlabsCookieBox`, `.brlbs-cmpnt-dialog` (v3), `._brlbs-bar-wrap` (v2) | v3 `.brlbs-btn-accept-only-essential`; v2 `a[data-cookie-refuse]` | Cookie `borlabs-cookie` (JSON); `BorlabsCookie.Consents.hasConsent` | `cookiesForBots`, `respectDoNotTrack`, GeoIP-диалог; `dialogShowDialogAfterUserInteraction` (поэтому есть A′); `dialogHideDialogOnPages` (на правовых страницах баннера нет — это норма) |
| 2 | Cookiebot | `window.Cookiebot`, `consent.cookiebot.com/uc.js` (или `.eu`) | `#CybotCookiebotDialogBodyButtonDecline`, `…LevelOptinDeclineAll` | `Cookiebot.consent.*`, `consent.method` (`implied`/`explicit`), cookie `CookieConsent` | `isSpider()`, `isOutOfRegion`, `CookieConsent=-1`; режим `implied` (согласие без клика) — отдельный вариант CONSENT-02/01 |
| 3 | Complianz | `window.complianz`, `#cmplz-cookiebanner-container` | `.cmplz-deny` | Cookies `cmplz_*`, `cmplz_get_banner_status()` | `complianz.region`, `consenttype` (`optin`/`optout`), бот-регулярка |
| 4 | Usercentrics v3 / v2 | `window.__ucCmp` / `UC_UI`; `#usercentrics-cmp-ui` / `#usercentrics-root`; open shadow DOM | v3 `[data-action-type=deny]`, v2 `[data-testid=uc-deny-all-button]` | `__ucCmp.getConsentDetails()` / `UC_UI.areAllConsentsAccepted()` | `isConsentRequired()`; регулярка ботов содержит `HeadlessChrome` и `Playwright/`, эффект ⚠ |
| 5 | CCM19 | `script[src*=ccm19][src*="app.js?apiKey="]`, `#ccm-widget` | `.ccm--decline-cookies`, иначе только второй уровень | Cookie или localStorage по настройке; JS-API ⚠ | Поздняя инъекция (ждём до HARD_CAP); бот и гео ⚠ |
| 6 | Real Cookie Banner | `window.consentApi`; `div[consent-skip-blocker="1"]` (id случайный на запрос) | Структурный селектор плюс словарь («ohne», «Ablehnen»), классы обфусцированы | `consentApi.consentSync`, cookie `real_cookie_banner*` ⚠ | `accept-all-for-bots` по умолчанию `true`, DNT-логика |
| 7 | CookieHub | `window.cookiehub`, `.ch2-container` | Гарантированной кнопки нет; часто только `.ch2-open-settings-btn` | `cookiehub.hasAnswered()`, `hasConsented(cat)`, cookie `cookiehub` | Бот и гео ⚠ |

Селекторы стартуют из правил `@duckduckgo/autoconsent@17.1.0` (MPL-2.0 разрешает брать селекторы; разметку «первый уровень» храним в своих файлах) и доков вендоров. Всё с ⚠ проверяем на CMP-лаборатории (раздел 9.5). Адаптер записывает `cmp.version`, если она доступна. Версия вне известного диапазона даёт уверенность `medium`.

### 4.3 Обобщённая эвристика и порог уверенности

Кандидаты: видимые элементы в main frame, open shadow roots и iframes с `role=dialog|alertdialog`, `aria-modal=true`, `<dialog open>`, или `position: fixed|sticky` с перекрытием ≥ 15 % вьюпорта либо полосой у края, **и** с ≥ 2 разными consent-ключевыми словами (`Cookie`, `Einwilligung`, `Datenschutz`, `Tracking`, `Dienste`, `Partner`, `Drittanbieter` и en-аналоги). Кнопки классифицируются по accessible name через `cmp/lexicon.yaml`. Стартовые веса (калибровать): адаптер 0,6; dialog-семантика 0,15; ключевые слова 0,15; найдена accept 0,1; «settings» ведёт к переключателям 0,1.

**Решение для MVP строже, чем в ресёрче.** Не согласен с browser-automation: там неизвестный CMP при score ≥ 0,8 давал CONSENT-04. ТЗ прямо запрещает ложный CONSENT-04 на неизвестном баннере. В релизе эвристика **никогда** не выдаёт CONSENT-04 уровня `warning` или `critical`, а только `info` «Banner nicht erkannt» с измеренными фактами (кнопки, тексты, блокировка, скриншот баннера) для ручной проверки. Вердикт по эвристике включается флагом `--consent-heuristics` только после того, как канарейка покажет precision ≥ 0,95 на размеченном корпусе.

### 4.4 Таблица решений для CONSENT-04

| Ситуация (фаза B до клика, плюс M) | Вариант | Уровень |
|---|---|---|
| Адаптер распознал CMP с уверенностью `high`; на первом уровне есть accept и видимая actionable кнопка класса reject | — | находки нет; метрики равноценности (площади, контраст, тип элемента) в evidence |
| Распознан; accept есть; reject на первом уровне нет (только «Einstellungen», «Verbergen», «Später», `×`); баннер **блокирует** (overlay, scroll-lock, `inert`/`aria-modal`, `elementFromPoint` в центре контента = баннер) на desktop **или** mobile | `blocking-no-reject` | `critical` |
| То же, но `×` по конфигурации CMP означает «принять всё» (если конфиг читаем) | `close-means-accept` | `critical` |
| Распознан; reject есть, но не actionable (перекрыт, вне вьюпорта без скролла, disabled) | `reject-not-actionable` | `warning` |
| Распознан; reject оформлен ссылкой, а не кнопкой | `reject-as-link` | `info` (EDPB TF Type C — оценка заказчика) |
| Распознан; reject нет; баннер **не** блокирует ни на одном viewport | `nonblocking-no-reject` | `info` (DSK Rn. 124–125: «nicht generell erforderlich»; ручная проверка) |
| Pay-or-Okay (`Abo`, `PUR`, `werbefrei` плюс цена на первом уровне) | `pur-abo` | `info`, CONSENT-04 к нему не применяем |
| Нет адаптера или уверенность ниже `high`; CMP распознан, но разметка или версия неизвестна | `banner-not-recognized` | `info` **«Banner nicht erkannt»** (ТЗ); статус проверки `inconclusive` |
| Гео- или бот-сигнал | — | `inconclusive`, `SCAN-GEO` / `SCAN-BOTMODE` |

«Блокирующий» измеряется, а не угадывается: состояние фиксируется в evidence (`blocking: {overlay, scrollLock, inert, coveredRatio}`), чтобы аудитор видел основание.

### 4.5 Проверка, что отказ сработал

После клика reject в фазе B — четыре независимых факта:

1. UI закрылся (контейнер скрыт или удалён).
2. Состояние CMP или consent-cookie означает отказ (`stateDenied`, `cookieDenied`).
3. После `reload` и перехода на следующую страницу баннер не появляется снова, состояние сохранилось (`persistedAfterReload`).
4. Сеть: после момента клика (по **времени начала** запроса) нет новых хитов категорий analytics/ads и новых не-необходимых cookies или записей хранилища. Это и есть CONSENT-05.

Комбинации: (1)+(2)+(3) истинны, но (4) нарушен → CONSENT-05. Клик прошёл, но (2) ложно → CONSENT-04 `reject-ineffective` (`warning`) плюс CONSENT-05 по трафику. Отказ возможен только через настройки → действие выполняется (нужно для CONSENT-05), а для CONSENT-04 это и есть доказательство варианта `blocking-no-reject` или `nonblocking-no-reject`.

### 4.6 Роль `@duckduckgo/autoconsent`

Закреплённая немодифицированная зависимость (MPL-2.0). Используется только для (а) распознавания «есть известный CMP X без нашего адаптера» (тогда текст «CMP X erkannt, nicht unterstützt»), (б) классификатора текста кнопок как второго мнения. **Его `optOut` и self-test не используются**: opt-out бывает через API (`Cookiebot.withdraw()`), через второй уровень и через cosmetic-скрытие. `prehide` и cosmetic отключены. Бандл инжектируется **после закрытия окна наблюдения фазы A**, чтобы не влиять на трафик до согласия. Не согласен с prior-art («зависимость для detect и opt-out»).

### 4.7 Pur-Abo, PIMS, TCF

- Pay-or-Okay: вариант `pur-abo` (`info`), ручная проверка.
- PIMS (§ 26 TDDDG, EinwV): в MVP не распознаём. Участие добровольное, признанных сервисов единицы (⚠ «Consenter»). После релиза — наблюдение `info`.
- TCF: читаем `__tcfapi('ping')` (`cmpId`, `gdprApplies`) как сигнал CMP и гео; TC-String не храним, только хэш при необходимости.

---

## 5. Модель данных и контракт

### 5.1 Сущности

| Сущность | Смысл | Ключевые поля |
|---|---|---|
| `CheckResult` | Выполнена ли проверка и что покрыто | `id`, `status` (`completed`/`partial`/`inconclusive`/`not_applicable`/`skipped`/`error`), `reason`, `coverage`, `logicVersion`, `durationMs` |
| `Finding` | Наблюдение после оценки | `checkId`, `variant`, `severity`, `confidence`, `crmCode`, `fingerprint`, `subject`, `phase`, `pages`, `classification`, `recipient`, `network?`, `evidence[]`, `messageId`, `params`, `title`/`summary` (отрендерены), `legalNoteId`, `related[]`, `serviceId`, `suppression` |
| `Diagnostic` | Проблема измерения, а не сайта. Никогда не гейтит и не идёт в CRM | `code` (`SCAN-GEO`, `SCAN-BOTMODE`, `SCAN-BLOCKED`, `SCAN-UNREACHABLE`, `SCAN-THROTTLED`, `SCAN-TIMEOUT`, `SCAN-SANDBOX-OFF`, `SCAN-PRIVATE-REQUEST-BLOCKED`), `affects[]` (checkId), `evidence[]` |
| `Evidence` | Отредактированный факт | `id`, `type`, поля типа, `phase`, `tMs` от навигации или клика |

Статусов `pass`/`fail` в контракте нет: «нет находки» не равно «соответствует». Не согласен с ресёрчем engineering (`checks[].status: pass|fail|…`).

### 5.2 Черновик JSON-отчёта

```jsonc
{
  "$schema": "https://<pages>/schemas/report/1.0.0.json",
  "schemaVersion": "1.0.0",
  "tool": { "name": "<product>", "version": "1.0.0", "rulesetVersion": "2026.11.0", "profile": "de-2026" },
  "scan": {
    "id": "01JC…", "target": "https://example.de/", "finalUrl": "https://www.example.de/",
    "startedAt": "2026-11-20T09:12:03Z", "durationMs": 214000,
    "status": "complete",                                  // complete | partial | failed
    "environment": {
      "userAgent": "Mozilla/5.0 … Chrome/156.0.0.0 Safari/537.36 <product>/1.0.0 (+<project-domain>/scanner)",
      "browser": { "engine": "chromium", "build": "chrome-for-testing", "version": "156.0.8078.4",
                   "headless": "new", "sandbox": true, "profile": "persistent-fresh-per-phase" },
      "locale": "de-DE", "timezone": "Europe/Berlin", "viewports": { "desktop": [1440, 900], "mobile": [390, 844] },
      "egress": { "mode": "direct", "region": "unverified" },
      "limitations": ["unload-beacons-partial", "server-side-forwarding-not-observable", "quic-disabled-by-proxy"]
    },
    "options": { "failOn": "critical", "lang": "de", "maxPages": 6, "overrides": [] },
    "coverage": {
      "pages": [{ "url": "https://www.example.de/kontakt", "phases": ["preConsent", "postReject"], "status": 200 }],
      "phases": { "preConsent": "completed", "preConsentInteraction": "completed", "postReject": "completed",
                  "postAccept": "completed", "mobileFirstLayer": "completed" },
      "skippedLinks": 3,
      "ownRequests": { "navigations": 16, "httpProbes": 14, "dns": 41, "tls": 4 }
    },
    "datasets": [{ "id": "services", "version": "2026.11.0", "sha256": "…" },
                 { "id": "cisa-kev", "version": "2026.11.18", "license": "CC0-1.0" }],
    "snapshotSha256": "…"
  },
  "summary": {
    "failOn": "critical", "thresholdExceeded": true, "exitCode": 1, "exitReason": "threshold",  // ok|threshold|check-error|coverage|fatal
    "counts": { "critical": 2, "warning": 5, "info": 7, "suppressed": 1, "baselined": 0 },
    "checks": { "completed": 24, "inconclusive": 1, "error": 0, "skipped": 6, "not_applicable": 2 }
  },
  "checks": [{ "id": "CONSENT-04", "status": "inconclusive", "reason": "banner-not-recognized", "logicVersion": "1.0.0" }],
  "diagnostics": [],
  "findings": [{
    "id": "f-7c1e", "fingerprint": "sha256:9b…", "fingerprintVersion": 1,
    "checkId": "TRACK-01", "variant": "hit-with-identifier", "severity": "critical", "confidence": "high",
    "crmCode": "T1_TRACKER_BEFORE_CONSENT",
    "phase": "preConsent", "pages": ["https://www.example.de/"],
    "subject": { "kind": "service", "id": "google-analytics-4", "label": "Google Analytics 4" },
    "serviceId": "google-analytics-4",
    "classification": { "category": "analytics", "source": "services@2026.11.0", "confidence": "high" },
    "recipient": { "company": "Google LLC", "hqCountry": "US", "dpf": { "listed": true, "checkedAt": "2026-10-30" } },
    "messageId": "TRACK-01.hit-with-identifier", "params": { "service": "Google Analytics 4", "hits": 3 },
    "title": "…", "summary": "…", "legalNoteId": "TRACK-01",
    "evidence": [
      { "type": "request", "id": "e12", "phase": "preConsent", "tMs": 1830,
        "url": "https://region1.google-analytics.com/g/collect?v=2&tid=G-ABC123&en=page_view&cid=«redacted»",
        "method": "POST", "resourceType": "ping", "status": 204, "serverIp": "142.250.…",
        "initiator": { "type": "script", "url": "https://www.googletagmanager.com/gtag/js?id=G-ABC123" } },
      { "type": "cookie", "id": "e13", "name": "_ga", "domain": ".example.de", "path": "/", "expires": "2028-11-20T…",
        "httpOnly": false, "secure": false, "sameSite": "Lax", "setBy": "js",
        "setter": "https://www.googletagmanager.com/gtag/js?id=G-ABC123", "valueLength": 27 }
    ],
    "related": ["f-19a4"], "suppression": null
  }],
  "legalContext": { "asOf": "2026-10-30", "items": [{ "id": "eu-us-dpf", "status": "in_force", "verifiedAt": "2026-10-30" }] },
  "disclaimer": { "messageId": "report.disclaimer", "text": "…" }
}
```

### 5.3 Типы evidence

Открытое перечисление: потребитель обязан игнорировать неизвестные типы.

| `type` | Ключевые поля | Покрывает требование ТЗ |
|---|---|---|
| `request` | url (с маскированием), method, resourceType, initiator, status, deliveryState (`completed`/`failed`/`blocked`), serverIp, tMs, consentParams (`gcs`, `gcd`, `npa`, `dma`) | URL, запрос |
| `connection` | host, ip, port, phase, tMs (из журнала egress-прокси; preconnect, beacon) | запрос |
| `cookie` | name, domain, path, expires, httpOnly, secure, sameSite, partitionKey, setBy (`header`/`js`), setter, valueLength | cookie |
| `storage` | kind (`localStorage`/`sessionStorage`/`indexedDB`), origin, key или имя БД, setter | cookie (расширение § 25) |
| `header` | url, name, value (для security-заголовков целиком; `Set-Cookie` без значения) | заголовок |
| `redirect-chain` | hops `[{url, status, location}]` | URL |
| `dns` | qname, qtype, rcode, answers, resolver, tMs | DNS-запись |
| `tls` | host, sni, ip, protocol, cipher, authorizationError, subject, san, issuer, validTo, fingerprint256, trustStore | — |
| `dom` | page, selector или a11y-путь, role, name, href, box, visibility | — |
| `cmp-state` | cmp, version, method (`api`/`cookie`), categories, raw-хэш | — |
| `consent-signal` | source (`dataLayer`/`gcs`/`gcd`), sequence, region, tMs | — |
| `document` | docUrl, sha256, lang, excerpt ≤ 200 знаков, location (заголовок раздела) | — |
| `mixed-content` | pageUrl, insecureUrl, resourceType, resolution (`blocked`/`auto-upgraded`/`warning`) | URL |
| `probe` | path, status, contentType, length, signatureId, soft404Baseline | URL, запрос |
| `component` | product, version, versionConfidence (`exact`/`range`/`unknown`), source, advisories[] | — |
| `screenshot` | sha256, file, region (`banner`), viewport | — |

### 5.4 `schemaVersion` и совместимость

- Семвер схемы независим от версии CLI. Minor: новое необязательное поле, новый `checkId`, новый `variant`, новый `evidence.type`, новый код диагностики. Major: удаление или переименование, смена типа, новое значение **закрытого** enum (`severity`, `status`), смена семантики `exitCode` или порога.
- Публикуемая схема не закрывает `additionalProperties`; внутренние тесты используют строгий вариант. Схема лежит в npm (`exports["./schema/report.json"]`) и на Pages по точной версии.
- `rulesetVersion` (CalVer) меняет уровни без смены схемы: каждый релиз с изменённым ruleset получает в CHANGELOG раздел «Severity changes». Стабильность CI обеспечивает пин образа по digest и baseline.
- Смена `crmCode` в маппинге — minor с пометкой в CHANGELOG, если CRM заказчика это переживает (решение К13).

### 5.5 Fingerprint, подавления, baseline

- `fingerprint = "sha256:" + hex(sha256(JCS({ v: 1, checkId, variantGroup, scope, subject })))`, где `scope` — eTLD+1 цели (плюс хост, если сканируется поддомен), `subject` — стабильный предмет: `serviceId` (TRACK-01, EMBED-*, CONSENT-01, PRIV-01), `name|domain|path|partitionKey` (CONSENT-02, HDR-02), имя заголовка (HDR-01), домен (MAIL-*), тип документа (LEGAL-01), `claimId+serviceId` (PRIV-02), `product+CVE` (VULN), путь (FILE-01). Не входят: время, query, значения cookies, порядок страниц, текст сообщения, severity.
- `variantGroup` — грубая группа варианта, чтобы смена `loaded` → `loaded-with-storage` не рождала «новую» находку.
- Подавления `.dsgvo-check/suppressions.yaml`: каждая запись обязана иметь `reason` и `expires`, `owner` опционален. Матчеры: `fingerprint`, `checkId` (glob), `serviceId`, `host` (glob). Подавление по `serviceId` убирает связанные находки разных ID одним правилом. Подавленные находки остаются в отчёте с флагом; просроченное правило снова учитывается и выводит предупреждение. Ошибки исполнения и неполное покрытие подавлять нельзя.
- Baseline: `<product> baseline create report.json` хранит `fingerprint` и `severity`. При `--baseline` гейтят только новые отпечатки **и** те, у которых уровень вырос.

### 5.6 Уровни и уверенность

- `severity`: `critical | warning | info` — закрытый enum. `info` никогда не гейтит.
- `confidence`: `high | medium | low`. Уверенность **ограничивает** уровень (кэп в ruleset): `high` — без ограничения, `medium` — не выше `warning`, `low` — не выше `info`. Отдельного гейтинга по уверенности нет, потому что пользователю нужна одна понятная ось.
- Пользователь может переопределить уровень в конфиге (`rules: { EMBED-01: { severity: critical } }`, как FAIL/WARN/IGNORE у ZAP). Переопределения видны в `scan.options.overrides`.

### 5.7 Точная семантика `--fail-on` и кодов `0/1/2`

`--fail-on critical` (по умолчанию) | `warning` | `none`.

Находка **учитывается**, если: не подавлена действующим правилом, не покрыта baseline (или её уровень вырос относительно baseline), и `rank(severity) ≥ rank(failOn)`.

Проверка **релевантна порогу**, если она включена, имеет `gating: true` в ruleset и её максимально возможный уровень (`maxSeverity` из ruleset с учётом кэпа) `≥ failOn`. Пример: MAIL-03 (максимум `warning`) при `--fail-on critical` нерелевантна, её сбой код не меняет.

Приоритет: **`2 (fatal)` > `1 (threshold)` > `2 (coverage)` > `0`**.

| Ситуация | Статус скана, проверок | Код |
|---|---|---|
| Нет учитываемых находок; релевантные проверки `completed`, `inconclusive` или `not_applicable` | `complete` | `0` |
| Есть учитываемая находка | `complete` или `partial` | `1`, даже если другие проверки упали: сигнал о сайте важнее сбоя |
| Баннер не распознан | CONSENT-04 `inconclusive` + `info` «Banner nicht erkannt»; CONSENT-05 и PRIV-02-зависимые `inconclusive` | Не влияет (ТЗ). `2` только при `--strict-coverage` |
| Одна релевантная проверка в `error` (исключение, коллектор не дал артефакт, DNS SERVFAIL или timeout после повтора) | `partial`, `exitReason: check-error` | `2`, если нет причины для `1`; `--on-check-error ignore` даёт `0` |
| Упала нерелевантная проверка | `partial` | Не влияет |
| Сайт недоступен: NXDOMAIN, отказ соединения на 80 и 443, таймаут навигации стартовой дважды, 5xx на стартовой дважды | `failed`, `SCAN-UNREACHABLE` | `2` |
| Сайт отвечает, но сертификат https невалиден | TLS-02 `critical`; браузерные проверки `skipped` (`reason: tls-blocked`), если не задан `--insecure-browser` (диагностический режим с пометкой) | `1` (если `--fail-on` не `none`) |
| WAF, челлендж, 403 на стартовой | `failed`, `SCAN-BLOCKED` | `2` |
| 429 на пробах | `SCAN-THROTTLED`, затронутые проверки `partial` | по правилам выше |
| Глобальный `--timeout` | Незавершённые проверки `error(timeout)`, `SCAN-TIMEOUT` | `1`, если есть учитываемая находка, иначе `2` при релевантных незавершённых |
| Бот-режим или гео-сигнал | Затронутые проверки `inconclusive`, диагностика | Не влияет; `2` при `--strict-coverage` |
| Sandbox не поднялся | `SCAN-SANDBOX-OFF` | Не влияет; `2` при `--require-sandbox` |
| Неверные аргументы или конфиг, URL не `http(s)`, браузер не установлен или не стартовал | — | `2`, сообщение в stderr |
| Внутренний сбой, unhandled rejection, OOM, SIGINT/SIGTERM | `failed`; частичный JSON, если успели | `2` |
| `--fail-on none` | — | `0` или `2` |
| Подавление просрочено | Находка учитывается, предупреждение | по порогу |

Не согласен с red-team Terra (приоритет `2 > 1` при одновременной находке и ошибке): ТЗ определяет `2` как «сканер сам упал», а при найденном `critical` действие разработчика одно — чинить сайт. Сбой нерелевантной проверки (DKIM timeout) не должен красить CI: это главный источник флейков.

---

## 6. Проверки

### 6.1 Владение наблюдениями (дедупликация)

Один запрос к `google-analytics.com` до клика не должен давать три находки `critical` с тремя отпечатками. На код возврата дубль не влияет (одна или три `critical` — всё равно `1`), но он ломает подавления, baseline и читаемость. Поэтому **у каждой категории сетевого наблюдения до согласия ровно одна проверка-владелец** (`data/routing.yaml`, данные, а не код):

| Категория сервиса (каталог) | Владелец | Остальные |
|---|---|---|
| analytics, ads, session-recording, tag-manager | TRACK-01 | CONSENT-01 перечисляет в сводке, без уровня |
| fonts | EMBED-01 | то же |
| maps | EMBED-02 | то же |
| video | EMBED-03 | то же |
| captcha | EMBED-04 | то же |
| widget, social, reviews, chat | EMBED-05 | то же |
| cdn-static, payment, consent (хосты CMP), hosting, other, unknown | CONSENT-01 | — |

Независимые оси (не дубли): **хранилище** (CONSENT-02 — cookies и Web Storage; правовое основание § 25 отличается от раскрытия IP по Art. 6), **сигналы Consent Mode** (CONSENT-06), **отсутствие баннера** (CONSENT-03), **поведение после отказа** (CONSENT-05). Связанные находки объединяются в отчёте по `serviceId` («Google Analytics 4: TRACK-01, CONSENT-02, CONSENT-06») и подавляются одним правилом по сервису. Для CRM разница несущественна: у CONSENT-01, CONSENT-02 и TRACK-01 один `crmCode` T1_TRACKER_BEFORE_CONSENT. Альтернатива «все ID срабатывают и группируются» — решение К5.

Единое правило для EMBED-*, выведенное из правовой карты: «§ 25 устоявшаяся для хранения, спорная для чистого запроса». Встраивание до клика — `warning`; если провайдер встраивания **записал cookie или хранилище** до клика — `critical`.

Колонка «DSE» — нужна ли страница Datenschutzerklärung.

### 6.2 P0 (подробно)

| ID | Фаза · источник | Детект | Уровень по умолчанию | Главный источник FP → защита | DSE |
|---|---|---|---|---|---|
| **PRIV-01** | A, A′, B, C · сеть, текст DSE (DOM, плюс до 2 связанных документов, плюс PDF в P1) | Инвентарь сервисов из всех фаз по каталогу. Текст DSE извлекается со скрытыми аккордеонами, табами, same- и cross-origin iframes и CMP-декларациями, нормализуется (регистр, умлауты ä/ae, дефисы и пробелы, мягкие переносы) и сегментируется на предложения под заголовками. Для каждого сервиса ищем алиасы продукта, компании и домены; уровень совпадения: `named` > `company` > `domain` > `category` > `none`. Упоминание в отрицании («wir verwenden keine …») не засчитывается и уходит кандидатом в PRIV-02 | `none` для категории с `policyRelevance: required` → `warning`; только категорийное описание («Webanalyse-Dienste») → `info` (Art. 13 допускает «Kategorien von Empfängern»); DSE не найдена, не разобрана или язык не de/en → `inconclusive`, находки нет | Сервис назван иначе, через оператора или категорией; текст в PDF или JS-виджете генератора; отрицания; шаблонные перечни → алиасы и компании в каталоге, категорийные термины, детектор отрицаний, извлечение скрытого текста, `inconclusive` вместо находки при неполном извлечении | да |
| **PRIV-02** | A, B (C — контроль) · сеть, DSE | Каталог проверяемых утверждений `privacy/claims.yaml`: регулярки de с исключением исторического и условного контекста плюс предикат наблюдения. Стартовый набор: «Google Fonts lokal eingebunden», «keine Cookies», «keine Analyse-/Tracking-Tools», «erst nach Einwilligung» (для конкретного сервиса), «erweiterter Datenschutzmodus» (YouTube) против `youtube.com`, «Matomo ohne Cookies» против `_pk_id`. Находка — цитата ≤ 200 знаков с URL и разделом плюс противоречащее наблюдение | `critical`: утверждение распознано с уверенностью `high` и противоречие наблюдается в фазе, о которой оно говорит (A или B); иначе `warning` | Цитата из другого раздела или продукта, «früher», намерение, условие → контекстные исключения, привязка к `serviceId`, требование нужной фазы | да |
| **CONSENT-01** | A, A′ (и B до клика) · сеть (`context.on`, журнал прокси) | Все сторонние запросы (eTLD+1 ≠ цели, плюс распознанные first-party-прокси), **начатые** до любого клика. Категории других владельцев только перечисляются в сводке (6.1); остаток оценивается. Одна находка на сервис, неизвестные хосты — одной агрегированной находкой | `warning`: известная не-необходимая категория без отдельного владельца (A/B-тестирование, marketing-automation, push); `info`: cdn-static, payment, unknown; хосты CMP — не находка | CDN, CMP, платёжка, анти-бот; CSP-заблокированные попытки; бот- и гео-режим → классы и `unknown` как класс, `deliveryState`, allowlist хостов CMP, `inconclusive` при сигналах | нет |
| **CONSENT-02** | A, A′ · `context.cookies()` по снимкам, `Set-Cookie` (CDP ExtraInfo), хук `document.cookie`, localStorage, sessionStorage, имена IndexedDB | Новые cookie и записи хранилищ до клика минус allowlist (consent-cookies CMP, сессия, LB, CSRF, язык). Ключ сравнения `(name, domain, path, partitionKey)`. Классификация: каталог сервисов, затем Open Cookie Database, затем эвристика сеттера | `critical`: известный трекинговый идентификатор (`_ga`, `_gid`, `_fbp`, `_gcl_au`, `_hjSession*`, `_pk_id` и аналоги в storage); `warning`: неизвестная persistent third-party; `info`: неизвестная first-party | Функциональная cookie с похожим именем; CMP-cookie с UID; режим Cookiebot `implied`; бот-режим (consent-cookie без клика) → allowlist, контекст сеттера (`setter`), детектор бот-режима | нет |
| **CONSENT-03** | A · DOM (адаптеры, autoconsent-детект, эвристика), сеть | Ни адаптер, ни autoconsent, ни эвристика не нашли кандидата баннера на стартовой и ещё на ≥ 1 странице, **и** есть сервисы, требующие согласия (TRACK-01, EMBED-02…05). Только шрифты или CDN — не CONSENT-03 (это EMBED-01) | `critical`: есть analytics/ads и на странице нет никакого CMP-скрипта, либо egress в ЕС подтверждён; `warning`: только embeds, либо CMP-скрипт есть, а баннера нет при неподтверждённом egress | Гео-таргетинг, бот-режим, баннер после взаимодействия, баннер в shadow DOM или iframe, `dialogHideDialogOnPages` → гео- и бот-сигналы, фаза A′, поиск во фреймах и shadow DOM, «CMP-скрипт есть» понижает | нет |
| **CONSENT-04** | A (чтение), B (до клика), M · DOM, a11y-имена, геометрия, состояние CMP | Таблица решений 4.4 | `critical` / `warning` / `info` по 4.4; неизвестный баннер — строго `info` «Banner nicht erkannt» | Кастомный баннер, локализация, shadow DOM, адаптивная вёрстка, кнопка вне вьюпорта → `warning`/`critical` дают только адаптеры распознанных CMP; блокировка измеряется на двух viewport | нет |
| **TRACK-01** | A, A′, B до клика, C · сеть (сигнатуры payload), `dataLayer` | Владелец analytics, ads, session-recording, tag-manager. Стадии: `library-loaded` → `hit` (событие или идентификатор по сигнатурам: GA4 `/g/collect` с `en`+`cid`, Meta `facebook.com/tr?ev=`, Google Ads conversion/remarketing, Hotjar `ws.hotjar.com`, Matomo `matomo.php?idsite`); first-party-прокси (sGTM, tag gateway) по пути и параметрам (`/g/collect`, `gtm.js` с first-party хоста, `server_container_url`) | `critical`: хит с идентификатором или событием до клика при уверенности `high`; `warning`: библиотека или контейнер без хита, first-party-прокси (уверенность `medium`); `info`: только после принятия (инвентарь) | GTM — лишь контейнер; Meta-URL как embed; ссылка в исходнике без выполнения; A/B-ротация → стадии, сигнатуры payload, только фактические запросы, репликация в B (3.4) | нет |
| **EMBED-01** | A, A′, B · сеть, DOM (`link rel`), журнал прокси | Запросы к font-хостам каталога (`fonts.googleapis.com`, `fonts.gstatic.com`, `use.typekit.net`, `p.typekit.net` ⚠, `use.fontawesome.com`/`kit.fontawesome.com`, `fonts.bunny.net`…) с цепочкой CSS → font; preconnect без загрузки — по DOM и журналу прокси | `warning` (Art. 6 и DSK Rn. 101; § 25 спорна; единственное решение LG München I). Только preconnect или dns-prefetch → `info`. Загрузка после отказа — тоже `warning` и сигнал для PRIV-02 | Self-hosted через свой CDN или прокси; stylesheet без загрузки шрифта → учитываем только фактические загрузки с хостов каталога | нет |
| **EMBED-02** | A, A′, B (Kontakt и Anfahrt в приоритете) · сеть, хранилище | iframe, JS API, статические тайлы (Google Maps, `maps.gstatic.com`, тайлы OSM, Mapbox, HERE и др. по каталогу) | `warning`; `critical`, если провайдер карты записал cookie или хранилище до клика | Обычная ссылка на Maps; локальная картинка карты; Zwei-Klick (мы не кликаем) → только сетевые факты | нет |
| **MAIL-01** | DNS | TXT `_dmarc` на хосте и tree walk RFC 9989 до организационного домена (≤ 8 запросов); парсер понимает теги RFC 7489 и RFC 9989; матрица MX и Null MX; NXDOMAIN и NODATA ≠ SERVFAIL и timeout | `warning`: нет записи, `p=none`, невалидна; `info`: `pct<100` или `t=y`, Null-MX-домен без `p=reject`, нет `rua` | DNS-сбой принят за отсутствие; домен не шлёт почту → `error` при SERVFAIL или timeout, матрица MX | нет |
| **MAIL-02** | DNS | Ровно одна `v=spf1`; статический разбор `include` и `redirect`, счётчик ≤ 10 lookups и ≤ 2 void, защита от циклов; оценка вместе с DMARC (BSI TR-03182: SoftFail допустим) | `warning`: нет записи, `+all`, `?all`, permerror, `~all` без DMARC `quarantine`/`reject`; `info`: `~all` при DMARC-enforcement, `ptr` | Каталог считает `~all` нарушением, BSI — нет → контекстная оценка с DMARC | нет |
| **HDR-01** | A (ответы главных документов стартовой, Impressum, DSE), HTTP-клиент для редиректов | Отдельная находка на заголовок, в отчёте сгруппированы: HSTS (только на https-ответе), CSP (header и `<meta>`; `frame-ancestors`), X-Frame-Options, `nosniff`, Referrer-Policy, Permissions-Policy | `warning`: нет HSTS; Referrer-Policy `unsafe-url` или `no-referrer-when-downgrade` (утечка полного URL третьим лицам); `info`: нет CSP, XFO/`frame-ancestors`, `nosniff`, Permissions-Policy, Referrer-Policy | HSTS через preload или родителя; CSP в meta; CDN добавляет заголовки только на части маршрутов → оценка нескольких страниц, учёт meta-CSP, формулировка «in der Antwort von [URL]» | нет |
| **TLS-01** | HTTP-клиент (`http://` хоста, apex и www; ручные редиректы ≤ 5), A (формы и http-ссылки) | Цепочка до https-2xx того же хоста; meta-refresh или JS-редирект из браузера; формы на http-странице; ссылки меню на свои http-поддомены | `critical`: http отдаёт 2xx, а https недоступен или невалиден, **или** на http-странице есть форма (§ 19 Abs. 4 TDDDG); `warning`: http 2xx без редиректа при рабочем https, редирект только через JS или meta; `info`: первый хоп не на https или на другой хост, http-ссылки на свои поддомены | HSTS-кэш браузера скрывает поведение сервера; на http заглушка → HTTP-клиент без HSTS-кэша, анализ содержимого http-ответа | нет |
| **TLS-02** | TLS-клиент (`node:tls`, SNI; Mozilla-store из Node, опция `--use-system-ca`) | `authorizationError` плюс собственный `X509Certificate.checkHost()` (Node не проверяет имя при ошибке цепочки) плюс срок; хост и www или apex, если используются | `critical`: истёк, имя не совпадает (чужой сертификат хостера), самоподписан, неизвестный корень; `warning`: неполная цепочка (браузеры её достроят), истекает ≤ 14 дней; `info`: ≤ 30 дней | Корпоративный TLS-прокси в CI, устаревший корневой store Node, AIA → trust store в evidence, `--use-system-ca` | нет |
| **LEGAL-01** | A и B (все посещённые страницы) · DOM (accessible name и href, включая скрытое меню, shadow DOM, баннер), HTTP GET целей с кэшем | Ссылки Impressum и Datenschutz (словарь меток, включая «Rechtliches», «Imprint», «Privacy»); резолв цели: 2xx, заголовок или текст, soft-404. Для `#` и `javascript:` проверяем, нет ли модала с содержимым в DOM. Перекрытие подвала баннером (`elementFromPoint`) без правовых ссылок в самом баннере. Фолбэк-GET `/impressum` и `/datenschutz` — только если ссылки не нашлись | `critical`: ни на одной проверенной странице нет ссылки и фолбэк не нашёл документ, либо ссылка ведёт на `#`, 4xx или soft-404; `warning`: ссылки нет на части страниц, документ найден только по фолбэк-пути (уверенность `medium`), подвал перекрыт баннером | Другие метки, мобильное меню, SPA, объединённые документы → поиск по всему DOM, проверка содержимого цели, фолбэк понижает до `warning`; формулировка «auf n von m geprüften Seiten» | сам находит DSE для PRIV |

### 6.3 P1 (кратко)

| ID | Фаза · источник | Детект | Уровень по умолчанию | Главный FP → защита | DSE |
|---|---|---|---|---|---|
| EMBED-03 | A, A′, B · сеть, хранилище | YouTube, `youtube-nocookie.com` (тот же сервис с атрибутом `privacyEnhancedMode`), `i.ytimg.com`, Vimeo по каталогу | `warning`; `critical` при cookie или хранилище провайдера до клика | Локальное превью; nocookie всё равно внешний → флаг режима, только сетевые факты | нет |
| EMBED-04 | A, A′, B · сеть, DOM (формы) | reCAPTCHA v2/v3/Enterprise (`recaptcha/api.js`, `enterprise.js`, `gstatic.com/recaptcha`), hCaptcha, Cloudflare Turnstile, Friendly Captcha; есть ли на странице видимая форма | `warning` на странице без формы; `info` на странице с формой | Скрытые формы, формы в модалках → DOM-факт формы как evidence, оценка «erforderlich» не делается | нет |
| EMBED-05 | A, A′, B · сеть, хранилище | Виджеты, соцсети, отзывы, чаты по каталогу (Elfsight `static.elfsight.com`, Trustindex `cdn.trustindex.io`, Instagram `cdninstagram.com`, чат-виджеты) | `warning`; `critical` при cookie или хранилище до клика | Общий CDN разных продуктов; локальный кэш отзывов → домены и пути каталога | нет |
| **CONSENT-05** (в релиз) | B · сеть по времени **начала** запроса, хранилище, журнал прокси | После верифицированного отказа (4.5): новые хиты analytics/ads, новые не-необходимые cookie и хранилища на стартовой после reload и на 2 следующих страницах; ответы на запросы, начатые до клика, исключаются | `critical`: хиты с идентификатором или новые трекинговые storage; `warning`: cookieless pings Consent Mode (`gcs=G100`, `gcd` с `denied`); `info`: только CONNECT к трекер-хосту по журналу прокси | Endpoint CMP, consent-update ping, запросы до клика → классы, тайминг по `requestWillBeSent` | нет |
| CONSENT-06 | A, B · `dataLayer` (хук `push` и чтение очереди), `gcs`/`gcd` в хитах Google, состояние CMP | Default для региона DE (`region` из команды; если DE не указан — default без `region`); побитовое декодирование `gcd`; сверка «CMP говорит denied, Google получает granted» | `critical`: Google получает granted (`gcs=G1x1`/`G11x`, `gcd` t/v/n/r) до клика или после отказа; `warning`: default granted без хитов, гонка «хит до default» | Временный granted с последующим denied до тегов; строка в исходнике → только исполненные команды с порядком и временем | нет |
| VULN-01 | A, Stage 2 · HTML и заголовки (generator, `?ver=` ядра, `readme.html`, `feed`) | Свои отпечатки WordPress, TYPO3, Joomla, Drupal, Shopware, Contao, Next.js; версия с уверенностью `exact`/`range`/`unknown`; advisories из OSV (Packagist, npm), WPVulnerability; KEV-пересечение; EOL мажоров | `critical`: версия `exact` **и** (CVE ∈ KEV **или** `AV:N/PR:N` с high impact класса RCE, SQLi, upload, auth-bypass); `warning`: прочие CVE при `exact`, EOL-мажор; `range` — на ступень ниже; `unknown` — `info` без CVE | Устаревший generator, backport, кэш → уверенность версии, `range` понижает, текст «Datenbank listet …», а не «verwundbar» | нет |
| VULN-02 | A (тела скриптов в памяти), Stage 2 (`readme.txt` и `style.css`, cap 20) | Плагины и темы WP по slug и версии (Elementor generator, `Stable tag`, `Version:`); JS-библиотеки по экстракторам retire.js (имя, содержимое, хэш) без доп. запросов; источники как у VULN-01 | Как VULN-01. jQuery < 3.5.0 (CVE-2020-11023 в KEV) по правилу каталога даёт `critical` — см. К14 | Одноимённые плагины, `?ver=` как cache-buster, bundled-копии → список компонентов, у которых `?ver=` — их версия; иначе `range` | нет |
| MAIL-03 | DNS | ≤ 25 TXT `<sel>._domainkey` в порядке MX-провайдера, затем generic; `--dkim-selector` от пользователя | `info` «unter N geprüften Selektoren nicht gefunden»; `warning` только для провайдеров с документированными фиксированными селекторами (Google `google`, M365 `selector1/2`), когда MX указывает на них; ключ < 1024 бит → `warning` | Случайные селекторы (SES, Postmark) → никогда «DKIM fehlt», список проверенных селекторов в evidence | нет |
| TLS-03 | A (https-страницы) · CDP `Audits.issueAdded` (MixedContentIssue: `insecureURL`, `resolutionStatus`), `Network.requestWillBeSent.request.mixedContentType`, DOM-скан `src`/`href`/`srcset`/`action`/`url()` | Chromium сам апгрейдит пассивный mixed content и блокирует активный ещё до запроса, поэтому сетевые события его не показывают (вывод критика, подтверждаю) | `warning`: активный (заблокирован) и форма с `action="http://"`; `info`: пассивный, автоматически апгрейдный | Обычная http-ссылка ≠ загрузка → только ресурсы и формы, статус `resolution` в evidence. Активен ли auto-upgrade при флагах Playwright ⚠ проверить фикстурой | нет |
| TLS-04 | TLS-клиент | 2 handshake (TLS 1.0, 1.1) с SNI, `DEFAULT@SECLEVEL=0`; план Б — сырой ClientHello через `net.Socket`. `ERR_SSL_NO_PROTOCOLS_AVAILABLE` = баг сканера (тест) | `warning`: принимается; `info`: «nicht eindeutig» (handshake_failure) | Локальная политика OpenSSL; CDN-edge против origin → коды ошибок различаются, IP в evidence | нет |

### 6.4 P2 (кратко)

| ID | Класс | Детект | Уровень | Главный FP → защита | DSE |
|---|---|---|---|---|---|
| DNS-01 | technical, DNS | CAA по дереву до eTLD+1; DS у родителя через `dns-packet` к системному резолверу. AD-флагу не доверяем; «цепочка сломана» — только с opt-in `--doh` | `info`; сломанная цепочка при DoH → `warning` | SERVFAIL ≠ unsigned → `error` | нет |
| HDR-02 | technical · `Set-Cookie` главных документов, заголовки `Server`/`X-Powered-By`/`X-Generator` | Атрибуты cookies; версии в заголовках (передаются в VULN как EOL-сигнал, например PHP ≤ 8.1) | `warning`: сессионная cookie (PHPSESSID, `wordpress_logged_in_*`, `fe_typo_user` и т. п.) без `Secure` или `HttpOnly`; остальное `info` | Не всем cookies нужен HttpOnly → эвристика «сессионная» | нет |
| ADMIN-01 | **exposure, opt-in**, только если обнаружен WordPress | `GET /wp-json/wp/v2/users` (храним только число записей), `GET /?author=1` без редиректа (только факт раскрытия slug), `GET /xmlrpc.php` (405 + «accepts POST requests only») | `warning`: пользователи раскрыты **и** XML-RPC активен; иначе `info` | Никаких попыток входа и POST → только GET | нет |
| FILE-01 | **exposure, opt-in** | Около 15 путей (`.git/HEAD`, `.git/config`, `.env`, `wp-config.php.bak/.old/~`, `.htpasswd`, `backup.zip`, `backup.sql`, `db.sql`, `dump.sql`, `wp-content/debug.log`, `phpinfo.php`, `.DS_Store`) — список утверждает заказчик; soft-404-базлайн 2 запроса; `Range: bytes=0-4095` + abort; совпадение сигнатуры; тело не сохраняется | `critical`: секреты, исходники, дампы; `warning`: debug.log, phpinfo; `info`: `.DS_Store` | SPA отдаёт 200 на всё → базлайн плюс сигнатура обязательна | нет |
| SEC-01 | technical | `/.well-known/security.txt`, затем `/security.txt`; парсер RFC 9116 (`Contact`, `Expires`) | `info` | HTML-заглушка → soft-404 | нет |
| LEGAL-02 | данные Impressum и DSE из LEGAL-01 | Словарь с `validFrom`: TMG → DDG, RStV → MStV, TTDSG → TDDDG, OS-Plattform (закрыта 20.07.2025), Privacy Shield, Safe Harbor; исключение исторического контекста | `info` | Цитата истории закона → контекстное окно | да (и Impressum) |
| BFSG-01 | После релиза, плагин | `@axe-core/playwright` в фазе B после отказа (баннер закрыт), теги `wcag2a/2aa/21aa`, ≤ 3 страницы | `info` (профиль `bfsg` → `warning`); никогда «BFSG-konform» | Анимации, overlay → после отказа и тишины | нет |
| PERF-01 | После релиза, плагин | Отдельный Lighthouse-прогон в фазе C, не входит в основной бюджет | `info`, `gating: false` | Шум прогона → медиана из N, «kein Rechtsbezug» | нет |

### 6.5 Кандидаты вне каталога (в бэклог, не в релиз)

CONSENT-07 «баннер снова показан после отказа», MAIL-04 (Null MX + `-all` + DMARC `reject` для неиспользуемых доменов), BFSG-02 (Erklärung zur Barrierefreiheit), распознавание PIMS (§ 26 TDDDG), профиль `eu-omnibus-preview`. Ресёрч regulatory предлагает их обоснованно, но любой новый ID — это расширение контракта, а релизный объём и так большой.

---

## 7. Данные и внешние источники

Политика лицензий (ADR): в репозитории и Docker-образе только CC0, PDDL, MIT, Apache-2.0, BSD, ISC, CC BY и немодифицированные MPL-2.0-зависимости. CC BY-SA и GPL-данные — только в кэше пользователя отдельными файлами и только по флагу. NC-данные — никогда, ни в каком режиме: заказчик продаёт аудиты. Собственный каталог собираем только из своих аудитов, наблюдаемого трафика и документации вендоров (§ 87a UrhG: перенос записей из чужой БД — это извлечение, а не «идея»). В CI проверяются лицензии зависимостей и манифест `datasets.lock.json`.

| Задача | Выбор | Лицензия | Режим | Почему так |
|---|---|---|---|---|
| Каталог сервисов (домены → сервис, компания, `hqCountry`, DPF, категория, алиасы для DSE, cookie-паттерны) | **Свой** `data/services/*.yaml`, старт около 100 записей из экспорта 80 аудитов заказчика | Apache-2.0 | В репозитории | Ядро PRIV-01/02 и `crmCode`; категорий fonts, maps, captcha, widget в нужной гранулярности нет ни в одном пермиссивном источнике |
| Fallback «неизвестный хост → компания, категория» | `third-party-web` | MIT | npm-зависимость | Около 2 100 сущностей, используется Lighthouse |
| Классификация cookies | Open Cookie Database | Apache-2.0 | Вендорим | Около 2 280 cookie с категорией и контроллером |
| CNAME-cloaking first-party-поддоменов | AdGuard `cname-trackers` плюс `dns.resolveCname` | MIT | Вендорим | Ловит маскированные трекеры |
| Второе мнение «это трекер» | EasyPrivacy и EasyList Germany через `@ghostery/adblocker` (ветка CC BY-SA 3.0) | MPL-2.0 (движок), CC BY-SA 3.0 (списки) | **Opt-in** `--blocklists`, кэш | Не согласен с data-sources (в конвейере по умолчанию): для немецких КМУ свой каталог точнее, а SA-данные нельзя смешивать с каталогом. Пересмотреть по результатам канарейки |
| Не используем | DuckDuckGo Tracker Radar, Disconnect, Ghostery TrackerDB (CC BY-NC-SA), cookiedatabase.org (NC-ND), Cookiepedia, форки Wappalyzer (GPL-3.0), webXray (GPL), AdGuard companiesdb (цепочка через NC-источник) | — | — | Лицензии |
| eTLD+1 | `tldts` | MIT (PSL внутри — MPL-2.0) | Зависимость | Обновляется с PSL |
| CMP | Свои адаптеры и `data/cmp/*.yaml`; `@duckduckgo/autoconsent@17.1.0` только для детекта прочих CMP и классификации кнопок; Consent-O-Matic — только референс селекторов | своё; MPL-2.0; MIT | Зависимость с точным пином | Вердикт CONSENT-04/05 только из своих адаптеров (4.6) |
| GeoIP и ASN | **По умолчанию выключено.** `--network-attribution`: DB-IP Lite Country+ASN плюс iptoasn | CC BY 4.0 (ссылка «IP Geolocation by DB-IP» в отчёте), PDDL | Снапшот в образе, обновление `update` | Не согласен с data-sources (DB-IP по умолчанию): страна IP при anycast почти ничего не говорит о получателе и провоцирует ложный вывод «Daten in die USA». Основной источник — `recipient` из каталога. MaxMind GeoLite2 и IPinfo — только по ключу пользователя, не в образе (EULA GeoLite2: уничтожение старых версий за 30 дней) |
| Третьи страны | Поля каталога `company`, `hqCountry`, `dpf {listed, checkedAt, source}`; `data/legal/adequacy.yaml` (ЕЭЗ и решения об адекватности, дата, ⚠ сверить актуальный перечень); `data/legal/context.yaml` (DPF: 2023/1795 в силе, апелляция C-703/25 P, письмо EDPB от 31.07.2026) | своё | В репозитории, `reviewBy` | Один флаг меняет все тексты, код не трогаем |
| VULN — WordPress (ядро, плагины, темы) | WPVulnerability.net по умолчанию; Wordfence Intelligence v3 по ключу пользователя | CC0; custom terms, коммерция разрешена ⚠ | Онлайн с кэшем | WPScan и Patchstack без договора нельзя |
| VULN — JS-библиотеки | retire.js `jsrepository` (данные; матчер свой) | Apache-2.0 | Вендорим, `update` | 0 дополнительных запросов: тела скриптов уже есть |
| VULN — TYPO3, Drupal, Joomla, npm | OSV.dev API (GHSA CC-BY 4.0); источники с NC-лицензиями фильтруем | по источнику | Онлайн с кэшем, опц. снапшот | В OSV нет WordPress-плагинов, поэтому WP отдельно |
| Признак `critical` | CISA KEV | CC0 | Вендорим снапшот, `update` | Правило каталога |
| Exploited-статус ЕС | ENISA EUVD | условия ⚠ | Opt-in | До выяснения лицензии |
| Обогащение CVSS | NVD | public domain, notice ⚠ | Только по ключу пользователя | Лимиты без ключа |
| EOL мажоров (PHP, TYPO3, Joomla, Drupal, jQuery 1.x/2.x) | Своя таблица `data/vuln/eol.yaml` по страницам вендоров | своё | В репозитории | Лицензия данных endoflife.date ⚠ |
| Отпечатки CMS и плагинов | Свои, с нуля | Apache-2.0 | В репозитории | GPL-форки Wappalyzer не берём |
| DKIM-селекторы | `data/dkim/providers.yaml` с `confirmed` | своё | В репозитории | Немецкие хостеры дособрать из `DKIM-Signature` писем 10 сайтов |

Модель обновления данных:

- Вендоренные снапшоты обновляет плановый workflow PR-ами. Выходят патч-релизы данных, образ пересобирается еженедельно.
- Онлайн-источники опрашиваются во время скана с кэшем. `--offline` использует только вендоренное.
- Недоступный источник даёт статус `partial` с причиной, а не «CVE nicht gefunden».
- Каждый использованный набор попадает в `scan.datasets` (версия, дата, лицензия, sha256), атрибуции — в подвал отчёта и `THIRD_PARTY_NOTICES.md`.

Владение данными: `services`, `cmp`, `fingerprints` ведёт разработка; `texts/de`, `legal/*`, `ruleset`, `crm` — заказчик. CI предупреждает, когда истёк `reviewBy` у записи `legal/context.yaml` или `legalNote`.

---

## 8. Отчёты

| Формат | Где | Содержание |
|---|---|---|
| **JSON** | `report.json`, всегда, в том числе частичный при сбое | Контракт раздела 5 |
| **Консоль** | stdout | Шапка (цель, профиль, egress, sandbox); находки по уровню, сгруппированные по сервису; покрытие; диагностика; строка `exitReason`. ANSI только в TTY. Строки с сайтов очищены от C0/C1 и bidi-override. `--quiet` и `--verbose` |
| **GitHub Job Summary** | `summary.md` → `$GITHUB_STEP_SUMMARY` | Счётчики, топ находок, покрытие, sha256 отчёта. Markdown и HTML экранированы, картинок нет |
| **JUnit** | `junit.xml` | testsuite на модуль, testcase на проверку; `failure` на учитываемую находку, `skipped` на `inconclusive`/`skipped`, `error` на ошибку проверки. Виден в MR-виджете GitLab Free |
| **HTML** | `report.html` | Один самодостаточный файл без JS (раскрытие через `<details>`), CSP в meta: `default-src 'none'; style-src 'sha256-…'; img-src data:; base-uri 'none'; form-action 'none'`, `referrer no-referrer`; системный стек шрифтов; скриншоты баннера как `data:`; URL с сайтов — текстом, не ссылками (клик по трекерному URL — это визит к трекеру). Разделы: Kopf (цель, время UTC, Prüfstand и Rechtsstand, ruleset), Zusammenfassung, Befunde (по сервису и по ID, с evidence), Abdeckung, Messumgebung, Diagnosen, Rechtlicher Kontext, Datensätze und Attribution, «Hinweis zur Art dieses Berichts». Preact SSR с экранированием по умолчанию, `dangerouslySetInnerHTML` запрещён линтером |
| **PDF** | `report.pdf` через `<product> report report.json --format pdf` | Тот же HTML в отдельном контексте Chromium: `javaScriptEnabled: false`, вся сеть `abort`; `page.pdf({format: 'A4', tagged: true, outline: true, printBackground: true})`; шрифты Noto и DejaVu в образе. PDF/A не делаем |

**Язык.** Тексты находок `de` (от заказчика) — язык по умолчанию; `en` вторым языком, `--lang en`. В JSON всегда есть стабильные `messageId` и `params` для машин и рядом отрендеренные `title`/`summary` на языке скана. Тексты — ICU MessageFormat 1 в `data/texts/{de,en}.yaml`, ключи `<ID>.<variant>.title|summary|description|remediation`, `<ID>.legalNote` (нормы, позиции надзора, статус `settled|contested|single|technical`, `reviewedBy`, `reviewedAt`), `report.disclaimer`, `report.bannerNotRecognized` («Banner nicht erkannt»). Генерации текстов под конкретный сайт нет. Формулировки фаз: «vor Interaktion mit dem Banner», «nach Betätigung von „[Text]“», «kein Banner erkannt».

**L0-линт текстов:** паритет ключей и плейсхолдеров `de`/`en`, парсинг ICU, лимит длины `summary` и **стоп-слова** для `de` из правовой карты §3.2: `verstößt`, `Verstoß`, `rechtswidrig`, `illegal`, `unzulässig`, `nicht DSGVO-konform`, `konform`, `bestanden`, `ohne Einwilligung`, `ohne Rechtsgrundlage`, `Datenleck`, `Sicherheitslücke`, `angreifbar`, `verwundbar`, `Abmahngefahr`, `Bußgeld droht`, `manipulativ`, `Dark Pattern`, `irreführend`, `Datenübermittlung in die USA`, `fehlendes Impressum`, `Datenschutzerklärung fehlt`, «Tracker» как голая метка. Исключение возможно только явным allowlist с причиной. Список ведёт заказчик.

**Дисклеймер.** Черновик из правовой карты §3.3, финал за заказчиком (ТЗ). Абзацы условные, чтобы текст всегда был правдой: например, «Bildschirmfotos des Banners sind enthalten» только при включённых скриншотах, «Netzwerkattribution per GeoIP» только при `--network-attribution`. Всегда присутствуют: автоматизированный характер, время UTC, egress, UA, версии сканера, ruleset и данных; «das Fehlen einer Beobachtung bedeutet nicht …»; не Rechtsberatung; что не сохраняется; Apache-2.0 без гарантий. Рядом — «Rechtlicher Kontext (Stand …)» из `legal/context.yaml`.

**Что редактируется** (в коллекторе, до снимка, поэтому чистым остаётся и `--save-artifacts`):

| Данные | Правило |
|---|---|
| Значения cookies | Никогда не сохраняются; только длина. Флага `--include-cookie-values` нет. Не согласен с engineering: с этим флагом дисклеймер становится ложным |
| Значения localStorage, sessionStorage, IndexedDB | Никогда; ключ или имя БД и длина |
| Query-параметры | Allowlist доказательных (`tid`, `id`, `v`, `en`, `ev`, `t`, `gcs`, `gcd`, `dma`, `npa`); остальные `«redacted»` |
| Заголовки с токенами (`Authorization`, `Cookie`) | Не сохраняются |
| POST-тела | Не сохраняются; у хитов Google разбираются только consent-параметры |
| TC-String | Только sha256 |
| FILE-01 | Тело никогда; id сигнатуры и длина |
| ADMIN-01 | Только число записей, без имён |
| Текст DSE и Impressum | Целиком только в локальных артефактах; в отчёте выдержки ≤ 200 знаков (PRIV-02, LEGAL-02) и sha256 документа. Персональные данные Impressum в выдержки не попадают |
| Скриншоты | Только область баннера (`locator.screenshot`), по умолчанию включены (решение К12), `--no-screenshots` |
| HAR | Выключен; `--har` пишет `content: 'omit'` без значений cookies и с предупреждением |

**Целостность.** В отчёте есть `snapshotSha256`; CLI и Job Summary печатают sha256 `report.json`. Подпись отчёта (sigstore/JWS) — после релиза.

---

## 9. Тестирование

### 9.1 Уровни

| Уровень | Что | Сеть | Гейтит PR | Бюджет |
|---|---|---|---|---|
| L0 | Типы, линт, валидность `data/*.yaml`, тест полноты реестра, паритет и стоп-слова текстов, граф импортов, дрейф JSON Schema, лицензии | нет | да | < 1 мин |
| L1 | Каждая проверка на записанных снимках (`violation`, `clean`, `inconclusive`); assess, gate, коды возврата (все строки таблицы 5.7), fingerprint, подавления, baseline; рендер отчётов | нет | да; ubuntu, плюс windows и macos | < 30 с |
| L2 | Коллекторы и проверки на локальных фикстур-сайтах с настоящим Chromium; TLS, DNS и HTTP на фикстур-серверах | `docker --network none` | да | < 7 мин |
| L3 | CLI в собранном образе (коды 0/1/2), `uses: ./` для Action, HTML без сетевых запросов | только локальная | да | < 5 мин |
| L4 | Канарейка: 10 сайтов заказчика плюс CMP-лаборатория | интернет | нет, ночью | — |

Раннер — Vitest 5 для L0–L2: тесты запускают наш сканер, а он сам управляет браузером, поэтому `@playwright/test` не нужен.

### 9.2 Требование ТЗ «для каждой проверки — фикстура с нарушением и чистая»

- **L1-пара обязательна для каждой зарегистрированной проверки** (в релизе до 31 ID; BFSG-01 и PERF-01 приходят плагинами со своими парами), плюс `inconclusive` для CONSENT-03/04/05/06, PRIV-01/02, LEGAL-01, VULN-01/02, MAIL-03. Тест полноты реестра не пропустит проверку без пары.
- **L2-пара** (`fixtures/site/violation`, `fixtures/site/clean`) обязательна для всех браузерных и сетевых проверок.
- L1-снимки **записываются из L2-прогонов** (`--save-artifacts` и нормализация). Отдельный тест сравнивает свежий L2-снимок с закоммиченной L1-фикстурой с точностью до нормализации. Так L1 не дрейфует от реальности.
- Golden JSON на каждый кейс (`toMatchFileSnapshot`), сериализатор нормализует время, порты, версии и пути.
- «Чистая фикстура» означает отсутствие конкретного сигнала, а не юридическую чистоту сайта.

### 9.3 Подмена доменов, TLS и DNS без интернета

- **Домены.** В тестовом режиме egress-прокси получает карту `host → fixture` и подменяет порт. Chromium ходит через прокси, Node-клиенты используют тот же инжектируемый резолвер. Получается одна таблица хостов на всё, и снимается неподтверждённый вопрос, умеет ли `--host-resolver-rules` подменять порт. Мульти-хост фикстур-сервер различает `Host` и SNI (`fonts.googleapis.com`, `www.googletagmanager.com`, `site.test`). Запрос к хосту вне карты получает 599 и роняет тест.
- **TLS.** Тестовый CA и листовые сертификаты генерируются при старте (`@peculiar/x509` или `selfsigned`, MIT); часы инжектируются. Валидность TLS проверяется только в Node-тестах TLS-02/04 с инжектированным `ca`. Браузер в L2 работает с `ignoreHTTPSErrors`, потому что TLS через браузер мы не утверждаем. Кейсы TLS-02: истёк, чужое имя (как `*.alfahosting-server.de`), самоподписан, неизвестный корень, неполная цепочка, истекает. TLS-04: Node-сервер с `TLSv1` и `DEFAULT@SECLEVEL=0` (работает ли с OpenSSL образа ⚠ спайк С4), план Б — фейковый сервер на сырых байтах ServerHello и Alert.
- **DNS.** `dns2` на UDP плюс инжектируемый `Resolver`. Кейсы: TXT длиннее 255 байт (склейка), две SPF, больше 10 lookups, void-lookups, DMARC tree walk, NXDOMAIN, NODATA, SERVFAIL, timeout, Null MX, DS.

### 9.4 Юнит на артефактах против интеграции с браузером

| Что проверяем | Где |
|---|---|
| Логика проверок, классификация, алиасы и отрицания PRIV, декодирование `gcd`, парсеры SPF, DMARC, security.txt, CSP, сравнение версий VULN, assess, gate | L1, быстро и детерминированно |
| Захват сети (подписка до навигации, worker, SW, beacon при загрузке), cookies и хранилища, алгоритм тишины, адаптеры CMP и клики, actionability, блокировка, mixed content через CDP Audits, извлечение текста DSE (аккордеоны, iframes), egress-прокси и SSRF | L2 |
| Упаковка, права, sandbox, коды возврата процесса, Action и шаблоны | L3 |
| Дрейф реальных CMP, калибровка порогов, precision и recall | L4 |

### 9.5 CMP: симуляторы и лаборатория

- **Симуляторы** пишем руками, код вендоров не копируем: те же опознавательные признаки (ID, классы, глобалы, consent-cookies) плюс конечный автомат. На каждый из 7 CMP кейсы: (а) равноценный отказ на первом уровне → чисто; (б) только «Zustimmen» и «Einstellungen», блокирующий → CONSENT-04 `critical`; (в) неблокирующий без отказа → `info`; (г) неизвестный баннер → `info` «Banner nicht erkannt»; (д) consent-cookie без клика → `inconclusive` и `SCAN-BOTMODE`; (е) гео-сигнал → `SCAN-GEO`; (ж) отказ не работает → CONSENT-05.
- **CMP-лаборатория** (решение К16): реальные установки 7 CMP на тестовом домене проекта с хостингом в ЕС — WordPress с Borlabs, Complianz, Real Cookie Banner, CCM19; аккаунты Cookiebot, Usercentrics, CookieHub. Лицензии и тарифы ⚠ уточнить. Лаборатория прогоняется ночью, ловит дрейф вендоров и служит калибровочным корпусом **до** того, как придут 10 сайтов заказчика.
- **Сайты самих вендоров CMP** (borlabs.io, cookiebot.com, complianz.io, usercentrics.com, ccm19.de, devowl.io, cookiehub.com) — корпус спайков этапа 0: только чтение, темп обычного посетителя, ToS и robots ⚠ проверить. Они же покажут бот-режим вендора (у borlabs.io `cookiesForBots: true`).

### 9.6 Канарейка по 10 реальным сайтам

- Приватный репозиторий (логи публичного репозитория видны всем, а отчёт о названной компании — Prangerwirkung). Письменное согласие владельцев сайтов получает заказчик.
- `expectations/<site>.yaml`: `mustFind` и `mustNotFind` по ID и варианту с комментарием аудитора. Размечает заказчик, это его эталон.
- Ночной прогон образа `edge` и текущего релиза из ЕС-egress, один проход на сайт. Результат: precision и recall по ID, diff между образами, issue на дрейф. Недоступный сайт даёт статус `unreachable`, а не провал; повтор не больше одного.
- **Критерии приёмки релиза** (предложение, утверждает заказчик): ноль ложных `critical` CONSENT-03/04 на корпусе; precision `critical` в целом ≥ 0,9; каждый пропуск P0 разобран и либо исправлен, либо задокументирован как ограничение.

### 9.7 Флейки

- В PR-тестах нет интернета (`--network none`, а не дисциплина).
- Фикстуры шлют трекеры синхронно или с известной задержкой меньше окна наблюдения; окна в тестах короткие (параметры конфигурации); никаких `waitForTimeout`; порты динамические; часы и TZ инжектируются.
- В L1–L2 ретраев нет: флейк — это баг. Ночью L2 гоняется с перемешиванием порядка N раз.
- Версия Chromium жёстко привязана к Playwright; обновления приходят PR от Renovate с полным L2/L3.
- В самом продукте вместо повторов скана: репликация в фазе B (3.4), флаг `quietNotReached`, кэп уровня по уверенности, правило «ошибка нерелевантной проверки не меняет код».

### 9.8 Прочие обязательные тесты

Контракт схемы (Ajv на каждом golden и L2/L3-отчёте, дрейф zod → JSON Schema без бампа, совместимость образцов прошлых minor); HTML-отчёт в Chromium с `route('**', abort)`: ноль запросов, ноль CSP-нарушений, ноль активных ссылок; фаззинг отчётов строками с `<script>`, bidi и ANSI в URL, именах cookies и заголовках; SSRF-тесты egress-прокси (RFC 1918, loopback, link-local, CGNAT, IPv6 ULA, IMDS v4/v6, редирект на `169.254.169.254`, имитация DNS-rebinding); матрица кодов возврата (каждая строка 5.7); тест «UA-токен не распознаётся как бот» (`isbot` и регулярки CMP); тест, что `ERR_SSL_NO_PROTOCOLS_AVAILABLE` в TLS-04 считается ошибкой сканера.

---

## 10. CI и дистрибуция

### 10.1 GitHub Action

- **Composite-action в корне репозитория**, которая выполняет `docker run` образа: `--init --user "$(id -u):$(id -g)" --cap-drop=ALL --security-opt=no-new-privileges --security-opt seccomp=$GITHUB_ACTION_PATH/action/seccomp.json --read-only --tmpfs /tmp --tmpfs /home/scanner --shm-size=1g --memory=3g --pids-limit=1024 -v "$out:/out"`. Docker-action отвергнута: по документации GitHub она обязана работать от root, а под root Chromium sandbox недоступен. Не согласен с red-team Terra (рекомендовала Docker-action).
- Inputs (только через `env`, без `${{ inputs.* }}` внутри `run`): `url`, `fail-on`, `formats`, `max-pages`, `lang`, `proxy` (из секрета), `config`, `baseline`, `extra-args`, `upload-artifact`, `verify-image`. Outputs: `exit-code`, `report-json`. Job Summary дописывается всегда. `actions/upload-artifact` закреплён по SHA, с `if: always()` и `retention-days: 14`.
- Рекомендация в README: сканер — отдельный job с `permissions: contents: read` и без `secrets.*`; публикация результатов — во втором job.
- **Ссылка на образ.** Engineering предлагал бампать digest в `action.yml` через release-please `extra-files`, но digest известен только после сборки образа, то есть после мержа Release PR. Предложение: workflow собирает и пушит образ по digest (без тега) с коммита Release PR, бот-коммит вписывает digest в `action.yml` того же PR, после мержа на тот же digest вешаются теги. Прототип на этапе 2 ⚠. Запасной вариант: точный тег `X.Y.Z` (политика — никогда не перезаписывается) плюс шаг `gh attestation verify` при `verify-image: true`.
- Только Linux в 1.0. Режим `node` (npx + `install`) для macOS и Windows — после релиза.

### 10.2 GitLab

- **Компонент CI/CD Catalog** в отдельном проекте на gitlab.com; `templates/` синхронизирует release-workflow с GitHub (deploy-токен в environment с обязательными ревьюерами). `spec:inputs`: `url`, `fail_on`, `formats`, `stage`, `soft_fail`.
- Job: `image: { name: ghcr.io/<org>/<product>@sha256:…, entrypoint: [""] }`, `script: <product> "$URL" --fail-on "$FAIL_ON" --out report/`, `artifacts: { when: always, paths: [report/], reports: { junit: report/junit.xml }, expire_in: 14 days }`. Мягкий режим: `allow_failure: { exit_codes: [1] }`, при котором код `2` остаётся красным.
- Для self-managed: `include: remote: … integrity: sha256-…` (GitLab ≥ 17.9).
- Ограничения в README: на shared runners seccomp не задать, поэтому fallback без sandbox и `SCAN-SANDBOX-OFF`; проектные переменные видны всем job'ам, поэтому job сканера держать без environment.

### 10.3 Docker-образ

- База `node:24-bookworm-slim` (Debian 12 поддерживается `playwright install-deps`; trixie ⚠) плюс `playwright-core install --with-deps --no-shell chromium` (полный Chrome for Testing для new headless). Не согласен с engineering (headless shell в основе): утечка `HeadlessChrome` через Client Hints бьёт по достоверности.
- Пользователь `scanner` (uid 10001), `tini`, `ENTRYPOINT ["<product>"]`, `/bin/sh` есть для GitLab; шрифты Noto и DejaVu; `LANG=C.UTF-8`; `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`; seccomp-профиль в `/etc/<product>/seccomp.json`; вендоренные снапшоты данных; OCI-лейблы.
- Multi-arch amd64/arm64, сборка нативно на `ubuntu-24.04` и `ubuntu-24.04-arm`, GHCR. Теги `X.Y.Z`, `X.Y`, `X` и еженедельный `X.Y.Z-YYYYMMDD`; точный `X.Y.Z` не перезаписывается; в документации — пин по digest.
- Размер: оценка 400–550 МБ в сжатом виде ⚠ замерить на этапе 1.

### 10.4 npm

Пакет `<product>`, ESM, bin. Зависимость `playwright-core` с точным пином. Браузер ставит явная команда `<product> install [--with-deps]`, а не postinstall (pnpm 11 `strictDepBuilds`, риск цепочки поставок). Без браузера и без TTY — код `2` с готовой командой. `engines >= 24`. В CI перед публикацией — `publint` и `@arethetypeswrong/cli`.

### 10.5 Пример репозитория, где Action роняет сборку

Репозиторий `<product>-example`:

- `site/`: статическая страница со ссылкой Impressum `href="#"` (LEGAL-01 `critical`), `fonts.googleapis.com` (EMBED-01 `warning`) и самописным баннером без отказа (ожидаемо `info` «Banner nicht erkannt» — заодно демонстрация честного поведения).
- Job 1 поднимает сайт локально и вызывает Action с `--allow-private`, `network: host`: падает с кодом `1`.
- PR «fix: Impressum verlinken, Schriften lokal einbinden» делает job зелёным.
- Job 2 сканирует ту же страницу на GitHub Pages (настоящий HTTPS и сторонние запросы).
- Бейдж в README. Аналогичный GitLab-проект на компоненте.
- Self-test основного репозитория: `uses: ./` с `continue-on-error` и проверкой `steps.scan.outputs.exit-code == '1'`.

### 10.6 Релизы и подпись

- release-please v5 (conventional commits, squash-merge); в CHANGELOG разделы «Severity changes» и «Data updates».
- npm Trusted Publishing (OIDC, автоматический provenance) и staged publishing с подтверждением через 2FA. Можно ли ставить в стейдж первую публикацию нового пакета ⚠ (changelog npm от 02.10.2026 по данным критика); публикуем через `npm publish`.
- Образ: BuildKit `--sbom=true --provenance=mode=max`, `actions/attest@v4` с `push-to-registry`; keyless `cosign` — опция. SBOM пакета (`pnpm sbom`, CycloneDX) прикладывается к GitHub Release.
- Renovate: одна группа `playwright-core` + `ARG` в Dockerfile + digest базы; `minimumReleaseAge` 1 день; Playwright и security-обновления без задержки (устаревший Chromium при визитах на недоверенные сайты — прямой риск).
- OpenSSF Scorecard ≥ 8, CodeQL, все `uses:` по SHA, `permissions: {}` сверху, без `pull_request_target`. Совместимость immutable releases с загрузкой ассетов ⚠ проверить.

### 10.7 CI самого проекта

`ci.yml` (L0/L1 на Node 24 и 26, L1 дополнительно на windows и macos, L2 в Docker, сборка образа без push, L3, actionlint); `nightly.yml` (L2 с перемешиванием, пересборка образа, сканер уязвимостей образа: Trivy или Grype ⚠ выбрать); `release.yml`; `scorecard.yml`, `codeql.yml`; канарейка — в приватном репозитории.

---

## 11. Безопасность и этика самого сканера

### 11.1 Граница пассивности: три класса действий

| Класс | Действия | По умолчанию | Лимит |
|---|---|---|---|
| O — наблюдение | Навигация по выбранным страницам, клик только по кнопкам «Ablehnen» и «Akzeptieren» CMP, `robots.txt`, sitemap, GET целей правовых ссылок, фолбэк `/impressum` и `/datenschutz` | вкл. | 6 страниц в A (15 при `--thorough`) |
| T — ограниченные технические пробы | DNS (≤ 60 запросов, включая ≤ 25 DKIM-селекторов: это публичные записи, а не доступ к сайту), TLS-handshake (≤ 5, включая пробы TLS 1.0 и 1.1), `http://`-цепочки, `security.txt`, файлы версий обнаруженных компонентов (`readme.txt`, `style.css`, `readme.html`, `feed`; cap 20) | вкл. | ≤ 2 запр./с |
| E — пробы экспозиции | FILE-01 (около 15 фиксированных путей), ADMIN-01 (3 GET) | **выкл.**, `--exposure-probes` | 4 KiB, без повторов |

**Запрещено всегда, независимо от флагов:** словари и wordlists, манипуляция параметрами, POST, отправка форм, попытки входа, вызовы XML-RPC, решение CAPTCHA, обход WAF и bot-блоков, stealth, реконструкция `.git`, использование найденных учётных данных, переход по найденным секретам. Валидатор `ProbeSpec` пропускает только GET, путь из данных проверки (или из обнаруженного slug), `maxBytes`, запросы без авторизационных заголовков; класс E — только с флагом. Не согласен с Sol (DKIM только по селектору от пользователя): короткий список селекторов — это DNS-запросы к публичным записям, а не доступ к сайту. Не согласен с http-dns (FILE-01 по умолчанию с `--no-files`): с учётом Modern Solution и 0 находок в 80 аудитах класс E только opt-in.

### 11.2 Служебные файлы (FILE-01)

Opt-in и предупреждение в README (Modern Solution: AG Jülich → LG Aachen → OLG Köln → BVerfG Nichtannahme, Az. ⚠). Список путей утверждает заказчик. `Range: bytes=0-4095` и обрыв соединения, лимит неотключаем. Тело не сохраняется и не печатается, только id сигнатуры и длина. Найденное никогда не используется. В тексте находки — рекомендация связаться с владельцем через `security.txt`. Флаг документирует выбор пользователя, но не создаёт разрешения владельца сайта: README прямо говорит «только свои или поручённые сайты».

### 11.3 Изоляция браузера

- `chromiumSandbox: true` (дефолт Playwright — `false`). В контейнере — non-root и seccomp-профиль с `clone`/`setns`/`unshare`. Если sandbox не поднялся, по умолчанию работаем без него с громким предупреждением и `SCAN-SANDBOX-OFF`; `--require-sandbox` даёт fail-closed (решение К19).
- `acceptDownloads: false` (дефолт Playwright — `true`), `permissions: []`, минимальный `env` браузера (`HOME`, `TMPDIR`, `LANG`, `TZ`), запрет схем кроме `http(s)`, попапы закрываются после записи, таймауты на страницу и на скан, `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` (актуальность флага ⚠).
- **Egress-прокси как SSRF-граница.** Если цель публичная, соединения в RFC 1918, loopback, link-local, CGNAT, IPv6 ULA, IMDS (v4 и v6) блокируются. Прокси резолвит один раз и соединяется по полученному IP, поэтому DNS-rebinding не проходит. Блокировка записывается в `SCAN-PRIVATE-REQUEST-BLOCKED`. Не согласен с engineering (`context.route('**')` в MVP): route отключает HTTP-кэш, конфликтует с тестовыми route и оставляет гонку «проверка — использование». Побочные плюсы прокси: реальный IP получателя в evidence, видимость preconnect и части beacon-соединений, одна точка для upstream `--proxy`. Минус: QUIC выключен (пишем в «Messumgebung»).
- CI: job без секретов, без `docker.sock`, смонтирован только `/out`. Еженедельная пересборка образа и быстрый апдейт Chromium. Внешние плагины — только явно.

### 11.4 XSS и инъекции в отчёте

HTML без JS, CSP, экранирование по умолчанию, URL текстом, `data:` только для наших скриншотов (перекодированы нами). Консоль и CI-логи: вырезаем C0/C1 и bidi-override; недоверенный вывод в GitHub оборачиваем в `::stop-commands::<random>` ⚠; в `$GITHUB_OUTPUT` пишем только значения, которые контролирует инструмент (коды, счётчики, пути). JUnit — через XML-построитель с вычисткой недопустимых символов. Job Summary — экранирование Markdown и HTML.

### 11.5 Данные в отчётах

Минимизация по таблице раздела 8. Отчёт о чужом сайте — чувствительный документ (§ 824 BGB, Prangerwirkung): срок хранения артефактов в шаблонах 14 дней, канарейка приватная, README запрещает публичную публикацию отчётов о третьих лицах. Содержимое сайтов не отправляется ни в LLM, ни в сторонние сервисы. Онлайн-запросы VULN передают третьим лицам (OSV, WPVulnerability) только slug и версию компонента, но не URL сайта.

### 11.6 Этика использования

Раздел README «Nutzungshinweise»: назначение — собственные и поручённые сайты; не для массового сканирования и подготовки Abmahnungen; что делает сканер и как его опознать (страница `<project-domain>/scanner`); честный UA; как владельцу сайта связаться с проектом. Лицензия запретить злоупотребление не может, поэтому защита — в дизайне: фактические формулировки, отсутствие экспорта «под претензию» и автоматических уведомлений, класс E выключен по умолчанию.

---

## 12. План по этапам ТЗ (0–4)

Оценки — для одного опытного разработчика, в человеко-днях (чд), без буфера.

| Этап | Результаты | Критерии готовности | чд | Зависимости | Что параллелить |
|---|---|---|---|---|---|
| **0 · Разведка** | Таблица аналогов (адаптация `prior-art.md` под формат сдачи); ADR-001…012; выбранный стек и источники CVE (раздел 7); воркшоп с заказчиком по К1–К6, К13; спайки: **С1** UA и имя против `isbot` и регулярок CMP; **С2** persistent против `newContext`, CfT против shell на сайтах вендоров CMP; **С3** Chromium sandbox и seccomp на GitHub-hosted runner и GitLab shared runner; **С4** проба TLS 1.0 с OpenSSL образа; **С5** прототип egress-прокси с Chromium (HTTP/2 через CONNECT, QUIC, preconnect); **С6** адаптеры Borlabs и Cookiebot. Запрос входных данных: экспорт аудитов (хосты, сервисы, `crmCode`), 10 сайтов с согласием владельцев, бюджет CMP-лаборатории, график DE-текстов | ADR приняты заказчиком; отчёты спайков с измерениями; имя выбрано; release manifest подписан | 6–7 | Доступность заказчика | Спайки параллельно (2 разработчика) |
| **1 · Каркас** | CLI (`scan`, `report`, `install`), конфиг, engine со стадиями; снимок и EvidenceStore с редактированием; реестр и тест полноты; assess, ruleset, gate, все коды возврата, подавления, baseline; JSON Schema 1.0.0-alpha (zod → JSON Schema, Ajv); консоль; egress-прокси и резолвер; HTTP-, TLS-, DNS-коллекторы с вежливостью; браузер фаза A (события, cookies и хранилища, тишина, DOM-факты, persistent-профили, UA); **первая проверка каждого модуля: EMBED-01 (browser), HDR-01 (http), TLS-02 (tls), MAIL-01 (dns)** с L1- и L2-парами; fixture-server (мульти-хост, тестовый CA, dns2); Docker-образ (CfT, non-root, multi-arch); CI проекта L0–L2 | `docker run <image> https://example.de` даёт валидный JSON и консоль; строки 5.7, реализуемые на этапе, покрыты тестами; 4 проверки с парами фикстур; SSRF-тесты зелёные; sandbox в GitHub runner работает или fallback задокументирован; CI зелёный | 18–20 | ADR по UA и имени (К2), семантике `critical` и кодов (К3, К4) | Разработчик A: core, схема, репортеры, gate. Разработчик B: коллекторы, браузер, прокси, образ |
| **2 · CI** | Composite Action с seccomp, Summary, upload; GitLab-компонент и `include:remote`; репортеры JUnit и Job Summary; примеры GitHub и GitLab «красная → зелёная»; L3 e2e; dry-run релизного конвейера (release-please, GHCR multi-arch, attest, npm OIDC в тег `next`) | В примере PR даёт `exit 1`, после фикса — зелёный (GitHub и GitLab); self-test `uses: ./`; pre-release артефакты опубликованы и проверяемы | 6–8 | Образ и CLI этапа 1 | Идёт параллельно с началом этапа 3 (один разработчик) |
| **3 · Проверки** | **3а, P0 и CONSENT-05 (≈ 52 чд):** фазы A′/B/C/M (2,5), каркас CMP и гео- и бот-сигналы (2), 7 адаптеров с симуляторами (8,5), эвристика и детект autoconsent (1,5), CONSENT-01/02/03/04, TRACK-01, EMBED-02 с routing и allowlist (5), CONSENT-05 (1,5), каталог сервисов около 100 записей и конвейер классификации (5), PRIV-01/02 (8,5), LEGAL-01 (2,5), MAIL-02 и TLS-01 (3,5), HTML, DE-тексты и линт (5,5), CMP-лаборатория, канарейка, калибровка (6). **3б, P1 (≈ 20 чд):** CONSENT-06 (2,5), EMBED-03/04/05 (2,5), VULN-01/02 и менеджер датасетов (9), MAIL-03 (1,5), TLS-03 (2), TLS-04 (1,5), PDF (1). **3в, P2 opt-in при буфере (≈ 6,5 чд):** SEC-01, LEGAL-02, HDR-02, DNS-01, FILE-01, ADMIN-01 | Все P0 и CONSENT-05 зарегистрированы с L1-парой (и L2 для браузерных и сетевых), golden JSON; канарейка на 10 сайтах и лаборатории проходит критерии 9.6; DE-тексты заказчика влиты, стоп-слова зелёные; HTML и PDF рендерятся; каждая P1 проходит те же критерии | 72–78 | Экспорт аудитов (начало 3а), 10 сайтов с согласием (лучше к концу этапа 1), DE-тексты (середина 3а), лицензии лаборатории | Трек B (браузер и согласие, около 21 чд плюс калибровка) параллельно треку D (каталог, PRIV, LEGAL, MAIL, TLS, VULN, отчёты, около 31 чд плюс небраузерная часть P1) |
| **4 · Релиз** | Заморозка схемы 1.0.0 с примерами; README (локально, GitHub, GitLab, Docker; список проверок генерируется из реестра; UA; Nutzungshinweise; ограничения; честное описание пределов отказа от ответственности по Apache-2.0); `SECURITY.md`, модель угроз; `THIRD_PARTY_NOTICES.md`; релиз 1.0.0 в npm, GHCR, Marketplace, GitLab Catalog с provenance; материалы для страницы на seed-factory.com; регламент обновления данных | Артефакты проверяемы (attestation); install-тесты из опубликованных артефактов зелёные; канарейка зелёная на релизном образе; заказчик подписал тексты и дисклеймер | 6–8 | Этап 3, ревью заказчика | Документация параллельно стабилизации |

**Итого:** около 108–120 чд; с буфером 15 % — около 125–135 чд. «Минимальный релиз» (P0 и CONSENT-05, без P1) — около 88–92 чд. При двух разработчиках это около 14–16 календарных недель, при одном — около 6 месяцев.

**Критический путь:** решения К2 (UA и имя), К3 и К4 → контракты `Snapshot`, `CheckDefinition`, схема отчёта → браузерный коллектор фазы A и egress-прокси → каркас CMP → адаптеры Borlabs, Cookiebot, Complianz (вместе 20 из 25 CMP-находок каталога) → CONSENT-04/05 → калибровка на корпусе → релиз. Вторая цепочка: экспорт аудитов заказчика → каталог сервисов → PRIV-01 (самая частая P0, 48/80) → калибровка. Главный риск сроков — корпус: ТЗ даёт 10 сайтов только «к этапу 3», а калибровать UA, профиль, тишину и адаптеры нужно раньше. Поэтому сайты запрашиваем на этапе 0, а до их появления опираемся на CMP-лабораторию и сайты вендоров.

**Что делать первым (первые две недели):** (1) воркшоп с заказчиком по К1–К6 и запрос входных данных; (2) спайки С1, С2, С3, С5 — они решают имя, тип профиля и модель безопасности, а это дорого менять позже; (3) контракты `Snapshot`, `CheckDefinition`, `ProbeSpec`, формат ruleset и alpha-схема отчёта — после них два трека идут независимо; (4) скелет репозитория и CI L0/L1.

---

## 13. Риски

| # | Риск | Вероятность | Влияние | Мера |
|---|---|---|---|---|
| 1 | CMP в бот- или гео-режиме «принимает всё» → ложные CONSENT-01/02/03 у чистых сайтов, CI клиента красный | высокая | высокое | UA-токен проходит бот-тест; рантайм-детекторы → `inconclusive` и диагностика; `--proxy` и ЕС-runner; CONSENT-03 `critical` только без CMP-скрипта или при ЕС-egress; A/B-замер на этапе 0 |
| 2 | Дрейф CMP (обновления вендоров, ежедневные релизы autoconsent) ломает адаптеры → тихие «nicht erkannt» или неверный вердикт | высокая | среднее | Ночная CMP-лаборатория и канарейка; версия CMP в evidence; селекторы как данные; fail-safe в `info`; issue на дрейф |
| 3 | Шум PRIV-01 (алиасы, категории, PDF, виджеты генераторов) подрывает доверие к самой частой P0 | высокая | высокое | Совпадения по уровням, категорийные термины → `info`, отрицания, `inconclusive` при неполном извлечении, размеченный корпус, ревью алиасов заказчиком, уровень `warning` |
| 4 | Поздние входные данные заказчика (10 сайтов, экспорт аудитов, тексты, решения) | средне-высокая | высокое | Запрос на этапе 0; лаборатория и сайты вендоров как временный корпус; ключи текстов заводятся рано с EN-заглушками; решения по умолчанию записываются в ADR |
| 5 | Правовой риск вывода (§ 824 BGB, RDG, Abmahn-злоупотребления, Modern Solution для FILE-01) | средняя | высокое | Только факты, стоп-слова, дисклеймер, класс E opt-in, отчёты не публикуются, Nutzungshinweise, ревью юриста заказчика |
| 6 | Компрометация CI через недоверенный JS (sandbox выключен) или SSRF к метаданным раннера | средняя | высокое | Sandbox и seccomp, egress-прокси, non-root, read-only FS, job без секретов, быстрые апдейты Chromium |
| 7 | Флейки измерений (таймерные теги, A/B-тесты, медленные сайты) красят CI | высокая | среднее | Алгоритм тишины, репликация в B, кэп уверенности, baseline, только релевантные ошибки дают `2`, калибровка окон |
| 8 | Перерасход оценки и расползание объёма (P1, P2, новые ID из ресёрча) | высокая | среднее | Release manifest, новые ID в бэклог, VULN последней в P1, еженедельный burn-down, буфер 15 % |
| 9 | Лицензионное загрязнение (NC- или GPL-данные, модификация MPL-файлов) | низко-средняя | высокое | ADR лицензий, манифест датасетов, CI-allowlist лицензий, чек-лист § 87a в PR каталога, autoconsent без модификаций |
| 10 | Источники уязвимостей недоступны или шумят (WPVulnerability — один мейнтейнер; сбои OSV; KEV-правило для jQuery) | средняя | среднее | Мульти-источник, кэш и `--offline`, `partial` вместо «нет CVE», уверенность версии, явное решение К14 |

---

## 14. Решения за заказчиком

Отмечено, где нужен именно DSGVO-эксперт (⚖), а где это продуктовое решение (⚙).

| # | Вопрос | Варианты | Рекомендация |
|---|---|---|---|
| К1 ⚙ | Объём релиза | A — все P0; B — все P0 плюс CONSENT-05; C — сокращённое ядро с явным списком исключений | **B**: проверка «Ablehnen» — суть идеи, стоит около 1,5 чд |
| К2 ⚖⚙ | Честный UA против бот-режима CMP; имя продукта | (а) полная GitHub-ссылка в браузерном UA, мирюсь с `inconclusive` у RCB и `isbot`-сайтов; (б) переименовать продукт, нейтральный токен плюс ссылка на страницу проекта на домене, проходящем бот-тест; (в) полная ссылка только в HTTP-пробах | **(б)+(в)** после спайка С1. Имя выбирать с CI-тестом против `isbot` и регулярок CMP и с проверкой товарного знака (DPMA, EUIPO); `dsgvo-check` не проходит (`check\b`) и занят на GitHub. Кандидаты для проверки: `dsgvo-lupe`, `datenlupe` ⚠ |
| К3 ⚖ | Что означает `critical` | A — доказанное нарушение; B — уверенный технический факт, приоритетный по утверждённой политике; C — любой серьёзный риск | **B**: A сканер гарантировать не может |
| К4 ⚙ | Коды при неполном скане | Таблица 5.7 | Недоступен или заблокирован → `2`; ошибка релевантной проверки → `2`, если нет `1`; нераспознанный баннер и бот- или гео-режим → не влияют (`--strict-coverage` для аудитов) |
| К5 ⚖ | Модель дедупликации CONSENT-01, TRACK-01, EMBED-* | (а) владелец категории (6.1); (б) срабатывают все ID, отчёт группирует | **(а)**: одно наблюдение — одна находка с уровнем; `crmCode` для CRM тот же |
| К6 ⚖ | Критерий CONSENT-04 | Блокирующий без отказа: `critical` или `warning`; неблокирующий: `info` или `warning`; отказ ссылкой; «Verbergen» и `×`; Pur-Abo; обязательность mobile | Как в 4.4: блокирующий → `critical`, неблокирующий → `info` (DSK Rn. 124–125), ссылка → `info`, «Verbergen» и `×=accept` = отсутствие отказа, Pur-Abo → `info`, mobile учитываем |
| К7 ⚖ | Находки фазы A′ (скролл, мышь, клавиша без клика) — это «до согласия»? | Да, тот же уровень; да, но ниже; нет | **Да, тот же уровень**, с пометкой `trigger` (Planet49; EDPB Guidelines 05/2020 Rn. 86 — дословно ⚠) |
| К8 ⚖ | Cookieless pings Google Consent Mode Advanced | Допустимо; автоматически `critical`; отдельный вариант | **Отдельный вариант `warning`** в CONSENT-01/05; CONSENT-06 им не триггерится |
| К9 ⚖ | Подписать таблицу уровней раздела 6 | Ключевые спорные: EMBED-01 `warning` против `critical`; правило «embed + хранилище = `critical`»; XFO `info`; TLS-01 с формой = `critical`; PRIV-02 `critical` только при противоречии в нужной фазе; reCAPTCHA без формы `warning`, с формой `info` | Как в разделе 6; для тех, кому нужно строже, — профиль `de-strict` |
| К10 ⚖ | Стандарт PRIV-01 | Обязательно имя бренда; продукт, оператор или категория с ручной оценкой; любое совпадение слова | **Только категория → `info`**, нет ничего → `warning` (Art. 13 Abs. 1 lit. e: «oder Kategorien») |
| К11 ⚖ | Пробы экспозиции и «активные» пробы | FILE-01 и ADMIN-01 по умолчанию или opt-in; состав путей; TLS-04 и DKIM по умолчанию | **E — opt-in**, список путей утверждает заказчик; TLS-04 и DKIM (≤ 25) — по умолчанию |
| К12 ⚖ | Что хранить в отчётах | Скриншоты баннера вкл. или выкл.; HAR; значения cookies; текст DSE | Скриншоты баннера **вкл.** (UrhG § 51 как цитата, только область баннера); HAR выкл.; значения cookies никогда; текст DSE только локально |
| К13 ⚙⚖ | Маппинг `crmCode` | Коды для P2; EMBED-03 (сейчас код карт); FILE-01 (T0 → какой код); `null` для диагностических и `info`-вариантов; политика смены маппинга | Отдельный код видео или подтверждение намеренной агрегации; `null` для «Banner nicht erkannt» и диагностики; смена маппинга — minor с записью в CHANGELOG |
| К14 ⚖ | KEV-правило для клиентских библиотек (jQuery 3.4.1 → `critical` по каталогу) | Оставить; понизить клиентские KEV до `warning`, если нет pre-auth server-side вектора | **Оставить правило каталога**, но только при версии `exact`, с поясняющим текстом; пересмотреть по данным канарейки. В каталоге для Next.js 15.2.8 нужен конкретный CVE ID (CVE-2025-29927 исправлен в 15.2.3; имелся ли в виду более поздний advisory ⚠) |
| К15 ⚖ | Нужен ли ЕС-egress для «доказательных» отчётов | Не нужен; нужен для аудитов; нужен всегда | **Для аудитов seed-factory — обязателен** (`--proxy` или ЕС-runner, `--strict-coverage`); в CI допустим `unverified` с ограничениями из 3.8 |
| К16 ⚙⚖ | Канарейка и CMP-лаборатория | Согласие владельцев 10 сайтов; кто размечает; бюджет лицензий CMP | Письменное согласие, разметка аудитором заказчика, бюджет на 7 CMP ⚠ |
| К17 ⚖ | Тексты и дисклеймер | Лицензия DE-текстов (Apache-2.0 в репозитории), DCO для контрибьюторов, финальный дисклеймер, нужен ли `en` | Apache-2.0, DCO, дисклеймер от заказчика к середине этапа 3, `en` в релизе |
| К18 ⚖ | Правовой статус самого проекта | CRA (manufacturer или OSS steward при коммерческом использовании), PLD, RDG для аудитов заказчика | Оценка юриста заказчика; на архитектуру не влияет, влияет на README и дисклеймер |
| К19 ⚙ | Sandbox по умолчанию | fail-open с предупреждением или fail-closed | **fail-open** с `SCAN-SANDBOX-OFF` (иначе ломаются GitLab shared runners); для аудитов — `--require-sandbox` |

---

## 15. ADR-кандидаты

| ADR | Решение |
|---|---|
| ADR-001 Граница продукта | Наблюдения без правовых выводов; три слоя: наблюдение → классификация → статический `legalNote`; никакой генерации правовых текстов под сайт |
| ADR-002 Release manifest | Все P0 и CONSENT-05; P1 по плану; P2 только opt-in и при буфере; BFSG-01 и PERF-01 — плагины после релиза |
| ADR-003 Конвейер | Коллекторы → неизменяемый очищенный снимок (sha256) → чистые проверки → оценка по ruleset → gate → репортеры |
| ADR-004 Контракт проверки | `CheckDefinition` с `requires`, декларативные `ProbeSpec`, явный реестр в слое проверок, тест полноты; без автозагрузки плагинов |
| ADR-005 Модель результата | Статус проверки ≠ уровень ≠ уверенность; уверенность ограничивает уровень; `Diagnostic` отдельно от находок; нет `pass`/`fail` |
| ADR-006 Коды возврата | Приоритет `2 (fatal)` > `1` > `2 (ошибка релевантной проверки)` > `0`; `inconclusive` не влияет без `--strict-coverage` |
| ADR-007 Схема отчёта | zod 4 → JSON Schema 2020-12, Ajv, независимый semver, открытые enum для evidence и диагностики, fingerprint v1 по JCS |
| ADR-008 Подавления и baseline | Обязательные `reason` и `expires`; матчеры `fingerprint`, `checkId`, `serviceId`, `host`; baseline учитывает рост уровня |
| ADR-009 Фазы согласия | A, A′, B, C, M; свежий persistent-профиль на фазу; алгоритм тишины; репликация через B |
| ADR-010 Браузер | Chrome for Testing new headless, `playwright-core` с точным пином; `context.on` плюс CDP (initiator, Audits); `route` не для наблюдения |
| ADR-011 UA и имя | Полная ссылка в HTTP-пробах; браузер — Chrome UA плюс токен, проходящий бот-тест в CI; имя выбирается под этот тест |
| ADR-012 Гео и бот-режим | Сигналы CMP → `inconclusive` и диагностика; `--proxy`; `egress` в отчёте; CONSENT-03 `critical` только без CMP-скрипта или при ЕС-egress |
| ADR-013 CMP | Свои 7 адаптеров (только чтение API, клик через actionability, верификация из четырёх фактов); autoconsent только для детекта после окна фазы A; эвристика даёт только `info` |
| ADR-014 Владение наблюдениями | `routing.yaml`: категория → проверка-владелец; группировка и подавление по `serviceId` |
| ADR-015 Каталог и лицензии данных | Свой каталог плюс third-party-web, OCD, cname-trackers; без NC; SA и GPL только кэш и opt-in; § 87a чек-лист |
| ADR-016 PRIV-конвейер | Извлечение DSE со скрытым текстом и фреймами; уровни совпадения; отрицания; каталог утверждений для PRIV-02 |
| ADR-017 Третьи страны | Атрибут `recipient` из каталога; GeoIP (DB-IP, iptoasn) opt-in; DPF в `legal/context.yaml`; на уровень не влияет |
| ADR-018 VULN | WPVulnerability (+ Wordfence по ключу), retire.js, OSV, KEV; `critical` = `exact` ∧ (KEV ∨ pre-auth high impact); `range` −1; `unknown` → `info` |
| ADR-019 Пассивный режим | Классы O, T, E; E opt-in; запреты; валидатор `ProbeSpec`; таблица вежливости |
| ADR-020 Ruleset | Уровни, gating, `maxSeverity`, `crmCode` — данные; CalVer `rulesetVersion`; профили; `legalBasis` с `verifiedAt` и `reviewBy`, CI на устаревание |
| ADR-021 Минимизация evidence | Редактирование в коллекторе до снимка; значений cookies нет; скриншоты только баннера; HAR выключен |
| ADR-022 Тексты и i18n | ICU MF1 в `data/texts/{de,en}.yaml`; `de` по умолчанию; стоп-слова; условный дисклеймер; CODEOWNERS заказчика |
| ADR-023 Egress-прокси | Локальный HTTP/CONNECT-прокси: SSRF-граница, журнал соединений, upstream `--proxy`, тестовая подмена хостов |
| ADR-024 Изоляция | `chromiumSandbox: true` с seccomp, fail-open и `--require-sandbox`; `acceptDownloads: false`; минимальный env; non-root, read-only |
| ADR-025 GitHub Action | Composite с `docker run` по digest и флагами изоляции; схема пина digest в Release PR |
| ADR-026 GitLab | Catalog-компонент на gitlab.com плюс `include:remote` с `integrity`; JUnit; `allow_failure: exit_codes: [1]` |
| ADR-027 Образ и npm | `node:24-bookworm-slim` + полный CfT, multi-arch, GHCR, неперезаписываемые точные теги; npm с `install`, без postinstall |
| ADR-028 Релизы | release-please v5, npm OIDC и staged publishing, attest и SBOM, Renovate с группой Playwright, Scorecard |
| ADR-029 Тестирование | L0–L4; L1-пара для каждого ID, записанная из L2; офлайн-сеть через egress-прокси; симуляторы CMP и лаборатория; критерии приёмки канарейки |
| ADR-030 Тулчейн и репозиторий | Node ≥ 24, TS 7, pnpm 11, Vitest 5, Biome и oxlint-tsgolint, undici 8; pnpm-workspace с одним публикуемым пакетом |
| ADR-031 Форматы отчёта | JSON, консоль, Job Summary, JUnit, HTML (без JS), PDF из HTML; SARIF и GitLab CQ после релиза |

---

## Приложение А. Где я расхожусь с ресёрчем раунда 1

1. **CONSENT-04 по эвристике для неизвестного CMP** (browser-automation: CONSENT-04 при score ≥ 0,8). В релизе неизвестный баннер даёт только `info` «Banner nicht erkannt»; эвристический вердикт — флаг после подтверждения precision ≥ 0,95. Причина: прямое требование ТЗ.
2. **Бот- и гео-режим понижать до `warning`** (browser-automation). Делаю `inconclusive` плюс диагностика: `warning` роняет `--fail-on warning` на недостоверном измерении.
3. **SSRF-фильтр через `context.route('**')` в MVP** (engineering). Использую egress-прокси: route отключает кэш, конфликтует с тестовыми route и оставляет гонку DNS.
4. **`newContext()` на скан** (engineering). Свежий persistent-профиль на фазу: `newContext` ведёт себя как Incognito (нет preconnect).
5. **Headless shell в основе образа** (engineering). Полный CfT и new headless: shell отдаёт `HeadlessChrome` в Client Hints.
6. **`checks[].status: pass|fail`** (engineering). Статусы покрытия без семантики «соответствия».
7. **`defaultSeverity` в коде проверки и пример `EMBED-01: critical`** (engineering). Уровни — данные ruleset; EMBED-01 по умолчанию `warning`.
8. **Флаг `--include-cookie-values`** (engineering). Убираю: с ним дисклеймер становится ложным.
9. **`engines >= 22.12`** (engineering). Неверно при undici 8 (`>=22.19`); выбираю `>= 24`, чтобы не делать мажор в апреле 2027.
10. **HTML — P1, PDF — P2** (engineering). Оба в релизе как рендер из JSON: этого прямо хочет идея, а стоит это около 4,5 чд.
11. **Digest образа в `action.yml` через release-please `extra-files`** (engineering). Digest известен только после сборки, предлагаю сборку из Release PR (10.1).
12. **TRACK-01 только `info`-инвентарь, уровень дают CONSENT-*** (regulatory, Sol). TRACK-01 — P0 с T1-кодом; делаю его владельцем analytics и ads с `critical` за хит до клика, а CONSENT-01 — владельцем остатка.
13. **FILE-01 по умолчанию с `--no-files`, около 30 путей** (http-dns). Opt-in класс E, около 15 путей по утверждению заказчика.
14. **MAIL-03 `warning` для IONOS и Strato** (http-dns). Только провайдеры с документированными фиксированными селекторами (Google, M365); остальные `info`.
15. **GeoIP DB-IP по умолчанию** (data-sources). Opt-in; основной источник — получатель из каталога.
16. **EasyPrivacy в конвейере по умолчанию** (data-sources). Opt-in до проверки на канарейке.
17. **autoconsent «для detect и opt-out»** (prior-art). Его opt-out не используем никогда; бандл инжектируем только после окна наблюдения фазы A.
18. **Docker-action для GitHub** (red-team Terra). Composite с `docker run`: Docker-action обязана работать от root, а значит без sandbox.
19. **Приоритет кода `2` над `1`** (red-team Terra). `1` важнее: ТЗ определяет `2` как падение сканера, а при найденной `critical` действие одно — чинить сайт.
20. **«Любая ошибка проверки → `2`»** (engineering). Только ошибка проверки, способной дать уровень не ниже порога; иначе DKIM-таймаут красит CI.
21. **DKIM только по селектору от пользователя** (Sol). Короткий список ≤ 25 по умолчанию: это публичные DNS-записи, а не доступ к сайту.
22. **TLS-03 через сетевые события** (browser-automation, engineering — неявно). Согласен с критиком: Chromium апгрейдит и блокирует mixed content до сетевого запроса; детект через CDP `Audits` (MixedContentIssue с `insecureURL` и `resolutionStatus`) и DOM-скан.
23. **`--max-pages` 10–20 по умолчанию** (engineering). 6 страниц: бюджет 3–4 минуты и вежливость.
24. **Новые ID CONSENT-07, CONSENT-08, MAIL-04, BFSG-02 в каталог** (regulatory). Обоснованы, но это расширение контракта; в бэклог после релиза.
