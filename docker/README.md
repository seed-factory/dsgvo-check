# Container image

`Dockerfile` (repository root) builds the scanner image:

- base `node:24-bookworm-slim`, pnpm through corepack (`packageManager` in `package.json`);
- the full Chrome for Testing in new headless mode (`channel: 'chromium'`, no headless shell), installed with
  `playwright-core install-deps chromium` and `playwright-core install --no-shell chromium` at the revision pinned by
  the locked `playwright-core` version; `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`;
- user `scanner` (uid/gid 10001), `tini` as PID 1, working directory `/work` for reports;
- `docker/entrypoint.sh` as `/usr/local/bin/dsgvo-check` (so `entrypoint: [""]` in GitLab still finds the CLI);
- `docker/seccomp-chromium.json` as `/etc/dsgvo-check/seccomp.json`.

```sh
docker build -t dsgvo-check --build-arg VERSION="$(jq -r .version package.json)" .
docker run --rm dsgvo-check --help
docker run --rm dsgvo-check seccomp-profile > dsgvo-check-seccomp.json
```

## Hardened run (the same flags as `action.yml`)

```sh
mkdir -p report
docker run --rm \
  --user "$(id -u):$(id -g)" \
  --cap-drop=ALL --security-opt no-new-privileges \
  --security-opt seccomp=dsgvo-check-seccomp.json \
  --read-only --tmpfs /tmp:rw,nosuid,nodev,size=1g --env HOME=/tmp \
  --memory=3g --memory-swap=3g --cpus=2 --pids-limit=1024 --shm-size=512m \
  --volume "$PWD/report:/out" \
  dsgvo-check https://www.example.de/ --out /out --format console,json,html,summary
```

Nothing else is mounted: no `docker.sock`, no workspace, no secrets. Exit codes are those of the CLI (0/1/2).

## Releases and digests

The Action and the GitLab template pull the image by digest, never by a tag (D24). The release workflow
(`.github/workflows/release.yml`, started by hand) builds and tests the image, pushes it to
`ghcr.io/seed-factory/dsgvo-check:<version>`, writes its digest into `action.yml` and
`templates/gitlab/dsgvo-check.gitlab-ci.yml` (`.github/scripts/pin-image.sh`), commits that and tags the commit
`v<version>`. Only the tag is pushed; on the default branch the digest is an all-zero placeholder, which the Action
refuses with a clear message. The label `org.opencontainers.image.version` carries the version of `package.json`.

## Why a seccomp profile

The scanner requires the Chromium sandbox by default (`--sandbox require`, D25). Chromium's Linux sandbox creates
user, PID and network namespaces and `chroot`s into an empty directory inside the new user namespace. Docker's
default seccomp profile allows `clone` with namespace flags, `unshare`, `setns` and `chroot` only to containers
with `CAP_SYS_ADMIN` / `CAP_SYS_CHROOT`, so with the default profile (and certainly with `--cap-drop=ALL`) the
browser does not start: "Chromium sandboxing failed!". `--privileged` or `--cap-add=SYS_ADMIN` would work, but give
the container far more than the browser needs.

`seccomp-chromium.json` is Docker's default profile plus one rule:

```json
{ "names": ["chroot", "clone", "setns", "unshare"], "action": "SCMP_ACT_ALLOW" }
```

Everything else is unchanged, including the `clone3` → `ENOSYS` rule that makes glibc fall back to `clone`.

Verified on 2026-10-30 (OrbStack, Docker 29.8.2, linux/arm64; `test/e2e/docker.e2e.test.ts`): with this profile,
`--cap-drop=ALL`, `no-new-privileges`, a read-only root filesystem and a non-root user, `chrome://sandbox` reports
"Layer 1 Sandbox: Namespace, PID namespaces: Yes, Network namespaces: Yes, Seccomp-BPF sandbox: Yes – You are
adequately sandboxed". With Docker's default profile and the same flags, the launch fails.

Trade-off: the rule lets processes in the container create user namespaces, which exposes more kernel code than
the default profile. That is the price of the browser sandbox, which isolates the renderer that executes untrusted
sites; it is still much narrower than `--privileged` or `CAP_SYS_ADMIN`.

### Sources and licenses

| Source                                                                                                                                                                                                | License    | Use                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------ |
| [moby/profiles `seccomp/default.json`](https://github.com/moby/profiles/blob/4b8214fc4971e06172938a1f1554ccff6647ee80/seccomp/default.json), commit `4b8214f`                                         | Apache-2.0 | base of the profile, copied unchanged                                                            |
| [jessfraz/dotfiles `etc/docker/seccomp/chrome.json`](https://github.com/jessfraz/dotfiles/blob/889e23d375b7a761faed6a59a4bae3f80cad74c4/etc/docker/seccomp/chrome.json), commit `889e23d`             | MIT        | the well-known Chrome profile; source of the idea to allow `chroot`, `clone`, `setns`, `unshare` |
| [microsoft/playwright `utils/docker/seccomp_profile.json`](https://github.com/microsoft/playwright/blob/1d5572d5ddfb7f3c8dfbbe19c8e97def0b2738db/utils/docker/seccomp_profile.json), commit `1d5572d` | Apache-2.0 | same approach (`clone`, `setns`, `unshare`)                                                      |

`chrome.json` itself is not used verbatim: it predates `clone3`, `rseq`, `statx` and other syscalls that current
glibc, Node and Chromium use, and it has no `clone3` → `ENOSYS` rule, so thread creation fails on current
distributions. Playwright's profile also lacks that rule; the browser research notes that a container with it did
not start on OrbStack/arm64. Starting from the maintained Docker profile avoids both problems.

To regenerate after a Docker profile update:

```sh
curl -fsSL https://raw.githubusercontent.com/moby/profiles/<commit>/seccomp/default.json \
  | jq '.syscalls = [{"comment": "dsgvo-check: Chromium namespace sandbox", "names": ["chroot","clone","setns","unshare"], "action": "SCMP_ACT_ALLOW"}] + .syscalls' \
  > docker/seccomp-chromium.json
corepack pnpm exec biome format --write docker/seccomp-chromium.json
```

## Size

About 1.45 GB unpacked on linux/arm64, mostly Chrome for Testing and the system libraries and fonts that
`install-deps` adds (fonts with umlauts and CJK glyphs for screenshots). The headless shell and Firefox/WebKit are
not installed.
