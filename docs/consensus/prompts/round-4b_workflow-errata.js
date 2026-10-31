export const meta = {
  name: 'dsgvo-check-errata',
  description: 'Round 6a: reconcile Fable + Codex Sol verifications into errata and apply them to the consensus README',
  phases: [{ title: 'Errata', detail: 'Opus applies verified corrections' }],
}
const REPO = '/Users/user/Documents/germany/coding-memes'
phase('Errata')
return await agent(`Рабочая директория: ${REPO}. Не трогай git, src/, test/ и прочий код (там параллельно работают другие агенты). Меняй только файлы, указанные ниже.

Ты — модератор консенсус-панели dsgvo-check (Claude Opus). Итог консенсуса docs/consensus/README.md проверили два независимых верификатора:
- docs/consensus/round-4/claude-fable-5.1_verification.md (Claude Fable 5.1)
- docs/consensus/round-4/codex-gpt-6.1-sol_verification.md (Codex GPT-6.1-Sol)
Прочитай оба целиком, README целиком, ТЗ и каталог (specs/). Для спорных пунктов открывай критики раунда 3 (docs/consensus/round-3/) и ресёрч (docs/01-research/) по месту.

Задача:
1. Сведи находки обоих верификаторов в docs/consensus/round-4/errata.md: таблица «№ → раздел/ID → проблема → кто нашёл (Fable / Sol / оба) → решение (принято / принято частично / отклонено / вопрос заказчику) → что изменено». Принимай, если находка подтверждена доказательством (цитата, первоисточник, ТЗ) — независимо от числа голосов; отклоняй с объяснением. Если верификаторы противоречат друг другу — разбери по аргументам. Отдельно: исправления передачи голосов (уровни согласия D03, D06, D08, D10, D13, D14, D15, D18, D26, D27 и т.д.) — сверь с round-3/votes-matrix.md и критиками.
2. Внеси принятые правки прямо в docs/consensus/README.md (в решения, таблицы, контракты, вопросы, риски, ADR-кандидаты), сохраняя структуру. В начало README после вводного абзаца добавь короткий блок «Поправки после верификации (раунд 4б)»: что изменилось и ссылка на errata.md. Обязательно отрази, если принято: контракт CMP-адаптера extract/act/verify с классификацией в чистой classifyFirstLayer в core; поведение --sandbox require для трёх входов ТЗ (npx, docker run, CI) и вопрос заказчику; единый EgressPolicy для прокси/undici/node:tls/net, --proxy в 1.0 только HTTP CONNECT, DNS — прямой резолвер, записанный в Messumgebung; честная граница SSRF при upstream-прокси; относительные пороги TLS-02 (6-дневные сертификаты); UA из navigator.userAgent/шаблона, а не browser.version(); chromiumSandbox: true для require; скриншот первого экрана без автопрокрутки (снимок viewport до действий, затем обрезка); полная CSP HTML-отчёта (default-src 'none'; img-src data:; style-src с хешем или 'unsafe-inline'); checkIP для IP-целей; THIRD_PARTY_NOTICES (MPL, CC BY GHSA); fingerprint subject для TLS-01/02 и всех релизных ID; уровни вариантов MAIL/DNS; VULN-02 not_applicable только без всех компонентов; модель delivery/result/provenance запросов и монотонная шкала времени; срез «Прототип (этап 1)» — сошлись на docs/prototype/BRIEF.md как на манифест прототипа, отделив его от релиза 1.0; pnpm 12.16.1 (актуальная версия на 30.10.2026, проверено по npm-реестру) вместо 11; §19 Abs. 4 TDDDG — Satz 3 или Absatz целиком; PRIV-01 не «самая частая P0» (HDR-01 64, MAIL-01 54).
3. Финальный ответ — StructuredOutput: число принятых/отклонённых/вопросов, и список изменений, которые обязаны попасть в остальные документы (02-architecture, 03-checks, 04-quality-and-delivery, 05-plan, legal/wording-guide, adr/*, 00-brief) — по каждому документу отдельно, конкретно (что заменить на что).`, {
  label: 'errata (opus)',
  phase: 'Errata',
  effort: 'xhigh',
  schema: {
    type: 'object',
    properties: {
      accepted: { type: 'integer' },
      rejected: { type: 'integer' },
      customerQuestions: { type: 'integer' },
      perDocument: {
        type: 'object',
        properties: {
          architecture: { type: 'array', items: { type: 'string' } },
          checks: { type: 'array', items: { type: 'string' } },
          quality: { type: 'array', items: { type: 'string' } },
          plan: { type: 'array', items: { type: 'string' } },
          wording: { type: 'array', items: { type: 'string' } },
          adr: { type: 'array', items: { type: 'string' } },
          brief: { type: 'array', items: { type: 'string' } },
        },
        required: ['architecture', 'checks', 'quality', 'plan', 'wording', 'adr', 'brief'],
      },
    },
    required: ['accepted', 'rejected', 'customerQuestions', 'perDocument'],
  },
})
