# Example: dsgvo-check stops a GitHub pipeline

A deliberately "red" build. The workflow publishes a small demo page to GitHub Pages and scans it with the
dsgvo-check Action in a separate job. The page contains two deliberate findings:

| Check      | Severity | Why                                                                      |
| ---------- | -------- | ------------------------------------------------------------------------ |
| `LEGAL-01` | critical | No link to an Impressum or a Datenschutzerklärung was found.             |
| `EMBED-01` | warning  | The font is loaded from `fonts.googleapis.com`, not from the own server. |

With `fail-on: critical` (the default), the critical `LEGAL-01` finding gives exit code `1` and the job fails. The Job
Summary lists the findings; the full report (`report.json`, `report.html`, `summary.md`) is uploaded as the artifact
`dsgvo-check-report` and kept for 14 days. The texts describe technical observations, not legal advice.

```
examples/github-failing/
├── .github/workflows/dsgvo-check.yml   # deploy to Pages, then scan in a separate job
└── site/index.html                     # demo page with the two findings
```

## Try it

1. Create a repository and copy this directory into it (including `.github/`).
2. In the workflow, set the Action release tag to use (`seed-factory/dsgvo-check@v0.1.0`).
3. In the repository settings, enable GitHub Pages with the source "GitHub Actions".
4. Push to `main`. The `deploy` job publishes the page, the `dsgvo-check` job fails with exit code 1.

Expected Job Summary (shortened):

```
## dsgvo-check – https://<user>.github.io/<repo>/ · Textentwurf

Scan vollständig · Exit-Code 1 (`threshold`)

| kritisch | Warnung | Hinweis | Prüfungsfehler | Nicht eindeutig |
| 1 | 1 | … | 0 | … |
```

## Turn it green

- Add `impressum.html` and `datenschutz.html` and link them from every page (fixes `LEGAL-01`).
- Self-host the font: serve it from `site/fonts/` and drop the Google Fonts link (fixes `EMBED-01`). It is only a
  warning, so it fails the build with `fail-on: warning`, not with `critical`.

## Notes

- Keep the scan in its own job with `permissions: contents: read` and no secrets: the scanner opens untrusted pages.
  The Action hardens the container itself, see the [README](../../README.md#github-action).
- To report without failing the build, use `fail-on: none` (only scan errors give exit code 2), or
  `continue-on-error: true` on the step and read `steps.<id>.outputs.exit-code`.
- GitHub-hosted runners are not guaranteed to be in the EU, so banners that depend on the visitor's location can
  behave differently there; see the `Messumgebung` section of `report.html`.
