# dsgvo-check — original idea

The customer's brief, faithful to the original meaning. The contract is in [dsgvo-check_TZ.md](dsgvo-check_TZ.md), and the list of checks is in [dsgvo-check_check-catalog.md](dsgvo-check_check-catalog.md).

A GDPR tool. The tool opens Playwright and records what happens before consent to cookies:

- which cookies are set, which third-party requests are sent: fonts, analytics, CAPTCHAs, YouTube/maps, data transfers outside the EU;
- whether the “Ablehnen” button works and what changes after rejection;
- whether Impressum and Datenschutz are present and accessible from every page;
- security headers, TLS, exposed service files (`.git`, `.env`, backups).

The output is a report (HTML/PDF) and an exit code for CI (optional).

## Roles

| Who | Area |
|---|---|
| Customer | DSGVO, security, documentation, German finding texts and disclaimer |
| Development | Browser automation, test frameworks, CI |

## Recorded decisions

- Language and stack: **TypeScript + Playwright**.
- License: Apache-2.0 (the `LICENSE` file is already in the repository; the specification permits MIT or Apache-2.0).
