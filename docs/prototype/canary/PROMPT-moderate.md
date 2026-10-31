Ты — модератор консенсуса по разбору канареечного прогона `canary/results/{{RUN}}/` прототипа `dsgvo-check`. Репозиторий — текущая директория. **Код и данные не меняй.** Писать можно только файлы, явно названные ниже.

## Входы

Две модели — Claude Fable 5.1 (`F-*`) и Codex GPT-6.1-Sol (`S-*`) — независимо разобрали прогон по пяти зонам. Промпт разбора — `docs/prototype/canary/PROMPT-triage.md`. Потом каждая проголосовала по находкам другой: `PROMPT-vote.md`.

Файлы в `canary/results/{{RUN}}/triage/`:
- `fable-<ZONE>.json`, `sol-<ZONE>.json` — находки, где `<ZONE>` ∈ CMP, REQ, LEG, NET, ROB;
- `sol-votes-on-fable-<ZONE>.json`, `fable-votes-on-sol-<ZONE>.json` — голоса;
- `merged.json` — плоская таблица «находка + голос».

Источник истины по поведению: `AGENTS.md`, `docs/03-checks.md` (реестр §2.1), `docs/consensus/README.md` (§2, §2а, §4, §5, «Поправки после верификации (раунд 4б)»), `docs/prototype/BRIEF.md`, `docs/prototype/STATUS.md`, `docs/prototype/review/FIXES.md`.

## Что сделать

1. **Сгруппируй дубли.** Сюда входят одинаковые дефекты из разных зон и от разных моделей: например, маскирование `mailto:` с пробелом, e-mail в тексте ссылок, обрезка CSP. Группа — один корень и одно исправление.

2. **Прими решение по группе.**

   | Решение | Когда |
   |---|---|
   | `fix` | Голосующий принял, автор и голосующий согласны, что это `code-bug` или `data-catalog`. Или находку нашли обе модели. |
   | `verify-then-fix` | Голос `verify`. Исправляющий сначала воспроизводит дефект на локальной фикстуре (L1/L2). Чинит, только если тест падает на текущем коде. |
   | `spec-question` | Код следует спецификации, но результат плохой, либо обе стороны свели вопрос к спецификации или заказчику. Код не трогать. Сформулируй вопрос заказчику с цифрами. |
   | `rejected` | Голос `reject` с доказательством, которое ты проверил и счёл верным. |
   | `by-design` | Упрощение BRIEF. |

   Если голоса внутри группы расходятся, реши сам по источнику истины, проверив данные и код. Обоснуй в `rationale`. Поправки голосующих к исправлению («Поправка: …») включи в `fix`.

3. **Назначь зону исправления** по файлам, которые придётся менять. Зоны владеют файлами:
   - `privacy` — `src/core/url.ts`, новый `src/core/redact.ts` (если нужен), `src/collectors/browser/{dom,util,in-page}.ts`; маскирование e-mail, `mailto:` и query в любых текстовых полях.
   - `cmp` — `src/cmp/**`, `data/cmp/**`, `src/collectors/browser/{cmp-bridge,screenshot}.ts`, `src/checks/browser/{consent-03,consent-04}.ts`, `src/core/report-schema.ts` и `schema/report.schema.json` (только поля CMP-evidence).
   - `legal` — `src/collectors/browser/{documents,pages,robots}.ts`, `src/checks/browser/{legal-01,priv-01}.ts`.
   - `requests` — `src/derive/**`, `src/collectors/browser/{recorder,features,jar,quiet}.ts`, `src/checks/browser/{consent-01,consent-02,consent-05,track-01,embed-01,embed-02,shared}.ts`, `data/services/**`, `data/routing.yaml`.
   - `net` — `src/collectors/{http,tls,dns}/**`, `src/core/headers.ts`, `src/checks/{http,dns}/**`.
   - `robustness` — `src/collectors/browser/{collector,launch,visit,challenge,ssrf}.ts`, `src/scan.ts`, `src/core/{gate,assess,snapshot,scan}.ts`, `src/cli.ts`, `data/texts/*/core.yaml`, `scripts/canary*.ts`, `README.md`.

   `data/texts/{de,en}/<module>.yaml` и `data/ruleset/**` правит та зона, чья проверка меняется. Если исправлению нужны файлы двух зон, назначь основную зону, а в `crossZone` опиши, что нужно от другой.

4. **Добавь к своей таблице:**
   - Правку формулировки Nutzungshinweise. В `data/texts/de/core.yaml`, ключ `usageNotes`, фраза «Phase C übermittelt die IP-Adresse … an die Drittanbieter» задевает правило 4 и правило 20 `docs/legal/wording-guide.md`. Разреши по guide, синхронизируй `en`, `--help` и `README.md`. Зона `robustness`, решение `fix`, если guide это подтверждает.
   - Локальное наблюдение оператора к F-ROB-10. В TMPDIR остались 11 каталогов `dsgvo-check-profile-*`, у пяти есть `Default/Cookies`. Все созданы между 14:25 и 17:04 по местному времени (UTC+1), то есть до старта `{{RUN}}` в 18:24. За время `{{RUN}}` новых не появилось. В первом прогоне процессы CLI убивались по timeout раннера, параллельно шли тесты. Реши, есть ли дефект очистки, например при SIGKILL от раннера или при падении, и какое исправление разумно.

## Выход

1. Запиши `canary/results/{{RUN}}/triage/consensus.json` — объект по схеме ниже, с siteId в `evidence`.
2. Верни тот же объект как финальный ответ.

Поля `title`, `rationale`, `fix`, `testPlan`, `question`, `crossZone` — по-русски. В `title`, `rationale`, `fix`, `testPlan`, `question` и `crossZone` **не пиши siteId, домены и имена сайтов**. Эти поля попадут в git, а результаты сканов чужих сайтов не публикуются (AGENTS.md п. 7). siteId — только в `evidence`.
