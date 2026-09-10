# skimasque-dev/connect

A GitHub composite action that opens an **identity-bound MASQUE tunnel** for the
rest of a CI job. It fetches a GitHub OIDC token, exchanges it at your skimasque
gateway for a short-lived credential, starts a local SOCKS5 relay, and exports
`ALL_PROXY` so the tools that follow egress through the gateway — subject to
policy.

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      id-token: write          # required — the action needs to mint an OIDC token
      contents: read
    steps:
      - uses: skimasque-dev/connect@v0.3.0
        with:
          proxy: gateway.example.com:443
          audience: https://gateway.example.com
          application: terraform

      # ALL_PROXY now points at a local SOCKS5 relay through the gateway.
      - run: terraform apply -auto-approve
```

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `proxy` | yes | — | Gateway address, `host:port`. |
| `audience` | yes | — | OIDC audience; must equal one of the gateway's `--oidc-audience` values. |
| `authority` | no | proxy host | TLS server name / `:authority` for the gateway. |
| `application` | no | — | Application name to declare (sent as `X-Masque-Application`, matched by policy). |
| `ca` | no | — | Path to a PEM the gateway's certificate chains to (for a private CA). |
| `listen` | no | `127.0.0.1:1080` | Local address for the SOCKS5 relay. |
| `version` | no | the ref this action was called at | `skimasque` release to install (e.g. `v0.3.0`). A moving ref (`v1`, `main`, a SHA) resolves to the latest release. |
| `repository` | no | `skimasque-dev/skimasque` | `owner/repo` to download the release from. |
| `client-bin` | no | — | Use this `skimasque-client` binary instead of downloading a release. |

## How it works

1. **Install** — downloads `skimasque-<version>-<target>.tar.gz` (and its
   `.sha256`) from the [`skimasque-dev/skimasque`](https://github.com/skimasque-dev/skimasque)
   release, verifies the checksum, and puts `skimasque-client` on `PATH`.
   Skipped when `client-bin` is set.
2. **Open the tunnel** — runs `skimasque-client --github-oidc`: the client reads
   the runner's OIDC token, POSTs it to the gateway's exchange endpoint, receives
   a ~1h credential, starts `skimasque-client … socks5` in the background, waits
   for the relay to accept connections, and writes
   `ALL_PROXY=socks5h://127.0.0.1:1080` to `GITHUB_ENV`.

The relay serves both `CONNECT` (TCP — HTTPS, git, databases, cloud SDKs) and
`UDP ASSOCIATE` (DNS and other UDP). TCP needs the gateway running with
**`--connect-tcp`**; without it only UDP egresses.

`socks5h://` (with the `h`) means the destination hostname is resolved
gateway-side, so DNS also goes through policy.

## Supported runners

`linux/amd64`, `linux/arm64`, `macos/arm64`, `windows/amd64`. Intel macOS is not
built — pass a binary via `client-bin` if you need one.

## The gateway and policy

This action is only the client side. The gateway (`skimasque-server`), the
policy DSL, and the optional control plane live in the main project. See
<https://github.com/skimasque-dev/skimasque>.

## License

MIT — see [LICENSE](LICENSE).
