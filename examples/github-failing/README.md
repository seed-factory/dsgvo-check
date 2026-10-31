# Example: dsgvo-check stops a GitHub pipeline

This example shows a "red" build. The workflow publishes a small demo page to GitHub Pages and then scans it
with the dsgvo-check Action. The page contains two deliberate findings:

| Check      | Severity | Why                                                                       |
| ---------- | -------- | ------------------------------------------------------------------------- |
| `LEGAL-01` | critical | No link to an Impressum or a Datenschutzerklärung was found on the page.  |
| `EMBED-01` | warning  | The font is loaded from `fonts.googleapis.com` instead of the own server. |

With `fail-on: critical` (the default), the critical `LEGAL-01` finding gives exit code `1`, so the job fails. The
Job Summary lists the findings; the full report (`report.json`, `report.html`, `summary.md`) is uploaded as the
artifact `dsgvo-check-report` and kept for 14 days.

The texts describe technical observations. They are not legal advice.

## Files

```
examples/github-failing/
├── .github/workflows/dsgvo-check.yml   # deploy to Pages, then scan in a separate job
└── site/index.html                     # demo page with the two findings
```

## Try it

1. Create a new repository and copy the contents of this directory into it (including `.github/`).
2. In `.github/workflows/dsgvo-check.yml`, replace the placeholder SHA in `uses: seed-factory/dsgvo-check@…` with
   the commit of a release tag (shown in the summary of the release job, or
   `git ls-remote https://github.com/seed-factory/dsgvo-check 'refs/tags/v0.1.0^{}'`).
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
- Self-host the font: download it once, serve it from `site/fonts/` and drop the Google Fonts link (fixes
  `EMBED-01`; it is a warning, so it does not fail the build with `fail-on: critical`, but it does with
  `fail-on: warning`).

## Notes on the setup

- The scan runs in its own job with `permissions: contents: read` and no secrets. The Action starts the scanner
  in a container as a non-root user with a seccomp profile for the Chromium sandbox, `--cap-drop=ALL`, a
  read-only root filesystem and memory/CPU limits. Only the report directory is mounted.
- Pin the Action by commit SHA (`uses: seed-factory/dsgvo-check@<sha> # v0.1.0`). Each release of the Action pins
  its image by digest (`ghcr.io/seed-factory/dsgvo-check@sha256:…`, D24), so the SHA fixes both the Action and the
  scanner. A tag (`@v0.1.0`, `:0.1.0`) can be re-published and is not used.
- To report without failing the build, use `fail-on: none` (only scan errors give exit code 2) or
  `continue-on-error: true` on the step and read `steps.<id>.outputs.exit-code`.
- GitHub-hosted runners are not guaranteed to be in the EU. Consent banners that depend on the visitor's location
  can behave differently there; see the `Messumgebung` section of `report.html`.
