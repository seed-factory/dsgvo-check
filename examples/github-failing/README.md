# Example of a failing GitHub check

The example workflow publishes a demo site to GitHub Pages, then scans the deployed URL in a separate job.
It uses the default `critical` threshold.

| Check      | Severity   | What the scanner observes                    |
| ---------- | ---------- | -------------------------------------------- |
| `LEGAL-01` | `critical` | No link to an Impressum or a privacy policy. |
| `EMBED-01` | `warning`  | A font request to `fonts.googleapis.com`.    |

## Run it

1. Copy the [workflow](.github/workflows/dsgvo-check.yml) and the [demo site](site/) to a test repository, preserving
   the directory layout.
2. Choose a published dsgvo-check Action tag and set it in the workflow.
3. In the repository settings, set the GitHub Pages source to **GitHub Actions**.
4. Push to `main` or run the workflow manually.

The scan exits with code 1 because the `LEGAL-01` finding reaches the threshold. The failed job still provides
a Job Summary and a `dsgvo-check-report` artifact with `report.json`, `report.html` and `summary.md` for 14 days.

## Make the scan pass

Add an Impressum and privacy policy and link to them from the demo page. This clears the critical finding.
Serve the font locally and remove the Google Fonts link to clear the warning as well.

For a reporting-only job, set `fail-on: none`. Scan errors can still fail the job. To check the exact status in a
later workflow step, use `steps.scan.outputs.exit-code`.
[Action inputs and scan isolation](../../README.md#github-action)
