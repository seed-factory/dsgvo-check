# Development

[Install and build](../README.md#installation) · [Architecture](architecture.md) · [Repository rules](../AGENTS.md)

## Commands

| Command | Use |
| --- | --- |
| `corepack pnpm typecheck` | Check source and test types |
| `corepack pnpm lint` | Run Biome checks |
| `corepack pnpm format` | Apply Biome formatting |
| `corepack pnpm build` | Build `dist/` and generate `schema/report.schema.json` |
| `corepack pnpm registry` | Regenerate the README variant table |
| `corepack pnpm env:example` | Regenerate `.env.example` |
| `corepack pnpm registry:check` and `corepack pnpm env:example:check` | Verify both generated files |

[package.json](../package.json) pins pnpm and dependency versions. TypeScript compiles the Node CLI without a
bundler. Runtime dictionaries and report templates in `test/data/` ship with the package and image.

## Tests

| Level | Command | Coverage |
| --- | --- | --- |
| L0–L1 | `corepack pnpm test:unit` | Data, schemas, architecture boundaries and pure check behavior |
| L2 | `corepack pnpm test:integration` | Chromium, HTTP, TLS and DNS against local servers |
| L3 | `corepack pnpm test:e2e` after a build | CLI, packaging and delivery contracts |
| Live | `corepack pnpm test:live` | Explicit opt-in runs against real sites |

`corepack pnpm test` runs only L0–L1. For one suite use
`corepack pnpm vitest run test/unit/core/evaluation/gate.test.ts`.

Check fixtures cover findings, clean and inconclusive results, and counterexamples. The registry tests verify that
every implemented variant has coverage. [Fixture locations](../AGENTS.md#adding-a-check)

### Affected tests

`corepack pnpm test:changed` uses Vitest's import graph and explicit mappings for data, fixtures and built CLI
entry points. The comparison includes changes since the merge base with `main`, plus local edits and untracked files.
Configuration and other broad changes can trigger a full run.

Use `--list` to preview the selection, `--project` to restrict it, `--base` to change the comparison ref,
`--files` to name paths, or `--all` to run everything. Put Vitest arguments after `--`.

### Local network fixtures

L2 routes browser traffic to the local fixture server using Chromium host resolver rules. This preserves the original
host name and SNI and keeps HTTP and HTTPS off the internet. Node trusts the test CA. Chromium trusts the shared
SPKI of valid test certificates, while expired or mismatched certificates use other keys.

- Register synthetic websites in [sites.ts](../test/fixture-server/sites.ts) and write their HTML in
  [sites/](../test/fixture-server/sites/). Use original fixture markup for provider simulations.
- Use [startFakeDns](../test/integration/dns/dns-server.ts) for local mail records.
- Each test file owns its temporary directory and binds servers to port 0. `DSGVO_TEST_WORKERS` controls
  file-level concurrency as a count or percentage. Use `1` for a serial run.

Ubuntu 24.04 CI enables unprivileged user namespaces for Chromium's native sandbox with
`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`. The container uses its own isolation.
[Docker isolation](../README.md#isolation)

### CI and container checks

[CI](../.github/workflows/ci.yml) checks types, formatting, the packed CLI and an offline HTML/PDF preview.
Pull requests run affected tests. Pushes to `main` run the full suites. CI defaults to four test workers.

The separate Docker job checks the image and the composite Action. To run the image suite against a local build:

```sh
DSGVO_E2E_IMAGE=dsgvo-check:dev corepack pnpm vitest run --project e2e test/e2e/docker.e2e.test.ts
```

## Canary

The canary measures scanner coverage, blocked and inconclusive results, CMP recognition and collection time on a
private sample. Prepare the sample locally from [sites.example.yaml](../canary/sites.example.yaml).

```sh
cp canary/sites.example.yaml canary/sites.yaml
corepack pnpm canary --dry-run
corepack pnpm canary --confirm
corepack pnpm canary:summary <runId>
```

Replace the fictional entries before running with `--confirm`. The runner writes to `canary/results/<runId>/`.
Use `--run-id` to resume and `--reanalyze <runId>` to evaluate saved snapshots offline. Summaries omit site names
by default. Run `node scripts/canary/main.ts --help` for all options.

- Use one entry per registrable domain, with a factual selection reason. The corpus covers organizations.
- Runs follow the standard passive [traffic limits](../README.md#what-the-scanner-sends) and log blocks as observed.
  The default is three workers and a five-second pause between sites per worker. The limits are five workers and
  a minimum pause of 1.5 seconds.
- Keep the corpus and results local. Delete raw results after evaluation and retain the anonymized summary.
- On an opt-out, stop the run, remove the site from the corpus and local run directories, and regenerate summaries.

## Release

Run the [Release workflow](../.github/workflows/release.yml) manually with the version from
[package.json](../package.json). It validates the version, confirms that the tag is new and checks that the rules and
German texts are approved. It then tests and publishes the container, creates `v<Version>` and prints the GitHub
Action tag and GitLab template integrity value.
