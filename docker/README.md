# Container image

The `Dockerfile` in the repository root builds the scanner image: `node:24-bookworm-slim`, the full Chrome for
Testing in new headless mode (`channel: 'chromium'`, no headless shell) at the revision pinned by the locked
`playwright-core`, a non-root user (uid/gid 10001) and `tini` as PID 1. `docker/entrypoint.sh` is installed as
`/usr/local/bin/dsgvo-check`, so `entrypoint: [""]` in GitLab still finds the CLI, and `docker/seccomp-chromium.json`
as `/etc/dsgvo-check/seccomp.json`.

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
  dsgvo-check https://example.test/ --out /out --format console,json,html,summary
```

Nothing else is mounted: no `docker.sock`, no workspace, no secrets. Exit codes are those of the CLI (0/1/2).

On a self-managed GitLab runner the administrator sets the same profile in `config.toml`
(`security_opt = ["seccomp=<file>"]`); without it the job ends with exit code 2 (`sandbox-unavailable`) unless
`DSGVO_CHECK_SANDBOX: "off"` is set explicitly. The scan job needs no secrets: bind deployment secrets to protected
environments.

## Releases

The Action and the GitLab template use `ghcr.io/seed-factory/dsgvo-check:<version>`, with the version from `package.json`. The release workflow builds and tests that image, pushes the version tag and creates the matching Action tag `v<version>`.


## Why a seccomp profile

The scanner requires the Chromium sandbox by default (`--sandbox require`). The sandbox creates user, PID and
network namespaces and `chroot`s into an empty directory. Docker's default seccomp profile allows `clone` with
namespace flags, `unshare`, `setns` and `chroot` only with `CAP_SYS_ADMIN` / `CAP_SYS_CHROOT`, so with the default
profile (and certainly with `--cap-drop=ALL`) the browser does not start: "Chromium sandboxing failed!".
`--privileged` or `--cap-add=SYS_ADMIN` would work but give the container far more than the browser needs.

`seccomp-chromium.json` is Docker's default profile plus one rule:

```json
{ "names": ["chroot", "clone", "setns", "unshare"], "action": "SCMP_ACT_ALLOW" }
```

Everything else is unchanged, including the `clone3` → `ENOSYS` rule that makes glibc fall back to `clone`.
`test/e2e/docker.e2e.test.ts` checks both sides: with this profile, `--cap-drop=ALL`, `no-new-privileges`, a read-only
root filesystem and a non-root user, `chrome://sandbox` reports "adequately sandboxed"; with Docker's default profile
and the same flags the launch fails.

Trade-off: the rule lets processes in the container create user namespaces, which exposes more kernel code than the
default profile. That is the price of the browser sandbox that isolates the renderer running untrusted sites; it is
much narrower than `--privileged` or `CAP_SYS_ADMIN`.

### Sources and licenses

| Source                                                                                                                                                                                                | License    | Use                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------ |
| [moby/profiles `seccomp/default.json`](https://github.com/moby/profiles/blob/4b8214fc4971e06172938a1f1554ccff6647ee80/seccomp/default.json), commit `4b8214f`                                         | Apache-2.0 | base of the profile, copied unchanged                                                            |
| [jessfraz/dotfiles `etc/docker/seccomp/chrome.json`](https://github.com/jessfraz/dotfiles/blob/889e23d375b7a761faed6a59a4bae3f80cad74c4/etc/docker/seccomp/chrome.json), commit `889e23d`             | MIT        | the well-known Chrome profile; source of the idea to allow `chroot`, `clone`, `setns`, `unshare` |
| [microsoft/playwright `utils/docker/seccomp_profile.json`](https://github.com/microsoft/playwright/blob/1d5572d5ddfb7f3c8dfbbe19c8e97def0b2738db/utils/docker/seccomp_profile.json), commit `1d5572d` | Apache-2.0 | same approach (`clone`, `setns`, `unshare`)                                                      |

`chrome.json` is not used verbatim: it predates `clone3`, `rseq`, `statx` and other syscalls that current glibc, Node
and Chromium use, and it has no `clone3` → `ENOSYS` rule, so thread creation fails on current distributions.
Playwright's profile also lacks that rule. Starting from the maintained Docker profile avoids both problems.

To regenerate after a Docker profile update:

```sh
curl -fsSL https://raw.githubusercontent.com/moby/profiles/<commit>/seccomp/default.json \
  | jq '.syscalls = [{"comment": "dsgvo-check: Chromium namespace sandbox", "names": ["chroot","clone","setns","unshare"], "action": "SCMP_ACT_ALLOW"}] + .syscalls' \
  > docker/seccomp-chromium.json
corepack pnpm exec biome format --write docker/seccomp-chromium.json
```
