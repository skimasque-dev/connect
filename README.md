# skimasque-dev/connect

Give a GitHub Actions job identity-bound access to private services through a
Skimasque MASQUE gateway. The client exchanges GitHub OIDC for a short-lived
credential and renews it while the job runs. Policy controls each TCP/UDP tunnel.

**Release coordination:** this branch requires the matching client changes.
Existing releases without `proxy-ready-v1` fail capability checks. Publish the
client first, then release the Action. Until then use `client-bin` built from the
matching client branch. Examples describe the new interface; previously
published `@v1` tags retain their previous behavior.

## Transparent access (default)

On a dedicated Ubuntu runner, configure private destination networks and DNS
once. Tools then use ordinary TCP/UDP sockets, including tools that ignore proxy
variables. Public traffic continues through the runner's normal network.

```yaml
jobs:
  deploy:
    runs-on: ubuntu-24.04
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: skimasque-dev/connect@v1 # use the coordinated new release
        with:
          proxy: gateway.example.com:443
          audience: https://gateway.example.com
          application: terraform
          routes: 10.42.0.0/16,fd42::/48
          dns-servers: 10.43.0.53,fd43::53
          dns-domains: ~internal.example
          probe-target: db.internal.example:5432
      - run: terraform apply -auto-approve
```

Transparent mode requires Ubuntu Linux, `/dev/net/tun`, `ip`, `unzip`, a working
systemd-resolved stub at `127.0.0.53`, `flock` (util-linux), and root or passwordless sudo. Use a current
GitHub runner supporting Node 24, at least
[v2.327.1](https://github.com/actions/checkout#checkout-v5). IPv6 must be enabled
for IPv6 routes or DNS.
Remove inherited `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and lowercase equivalents:
they could bypass split routing. Unsupported runners fail before network changes;
select `mode: proxy` explicitly for fallback.

Each instance owns its TUN link, routing table, destination policy rules and
per-link DNS. DNS servers receive tunnel routes even outside `routes`. Only
listed private DNS domains use those servers. Default routes, `~.`, loopback,
link-local and gateway-overlapping ranges are rejected. List **both** IPv4 and
IPv6 networks for services with A and AAAA records. The gateway currently needs
an IPv4 address; destinations support both families.

TCP and UDP work, including UDP/TCP DNS. ICMP/ping and arbitrary IP protocols are
outside this interface. Transparent tunnels carry IP destinations: grant IP/CIDR
policy, not only hostname rules. Addresses outside `routes` use normal routing,
so configure every private destination range. Policy governs tunneled traffic;
the Action does not isolate the runner's public network.

## Explicit proxy mode

Use `mode: proxy` on Windows, macOS, or Linux without transparent prerequisites.
It requires no elevated privileges. HTTP and HTTPS CONNECT use the HTTP
listener; SOCKS clients can use TCP CONNECT and UDP ASSOCIATE.

```yaml
- uses: skimasque-dev/connect@v1 # use the coordinated new release
  with:
    mode: proxy
    proxy: gateway.example.com:443
    audience: https://gateway.example.com
- run: curl https://private.example
```

The Action exports uppercase and lowercase `HTTP_PROXY` / `HTTPS_PROXY` as
`http://127.0.0.1:8080`, `ALL_PROXY` as `socks5h://127.0.0.1:1080`, and `NO_PROXY`
as `localhost,127.0.0.1,::1`. HTTPS uses an `http://` proxy URL because TLS passes
through CONNECT. `socks5h` resolves at the gateway. Tools must support proxies;
environment variables cannot intercept raw sockets. One proxy-mode instance
may export job-wide variables at a time; cleanup restores previous values.
Transparent mode exports no global proxy variables.

## Inputs and outputs

| Input | Default | Description |
|---|---|---|
| `proxy` | required | Gateway `host:port`. |
| `audience` | required | Matches gateway `--oidc-audience`. |
| `mode` | `transparent` | `transparent` or `proxy`. |
| `routes` | required for transparent | Comma/newline-separated private IPv4/IPv6 CIDRs. |
| `dns-servers` | required for transparent | Comma/newline-separated private DNS IPs. |
| `dns-domains` | required for transparent | Private routing domains, e.g. `~internal.example`. |
| `authority` | original gateway host | Gateway TLS name and HTTP authority. |
| `application` | empty | Application context matched by policy. |
| `ca` | empty | Private CA PEM path. |
| `listen` | `127.0.0.1:1080` | SOCKS loopback address; port `0` selects a free port. |
| `http-listen` | `127.0.0.1:8080` | HTTP loopback address; port `0` selects a free port. |
| `version` | action ref | Client release; moving refs resolve to latest. |
| `repository` | `skimasque-dev/skimasque` | Client release repository. |
| `client-bin` | empty | Existing client; required capabilities still checked. |
| `probe-target` | empty | Optional `host:port` TCP readiness check. |
| `startup-timeout` | `30` | Startup timeout seconds, `1`–`300`. |

Outputs: `mode`, `http-proxy`, `socks-proxy`, `state-file`. Explicit proxy URLs are
available in either mode. Downloaded client archives are checksum verified;
native TUN forwarding is embedded using tun-rs and a smoltcp-based stack. No
additional networking executable is downloaded. Client downloads support Linux
amd64/arm64, Windows amd64 and macOS arm64; other platforms need `client-bin`.

## Readiness and cleanup

Ready means authenticated client readiness, both listeners, native TUN attachment and
verified routes/DNS. `probe-target` adds a real TCP check. The supervisor watches
the unprivileged client throughout the job. If the client dies, private routes become unreachable
until cleanup while public routing continues. Diagnostics and a write-ahead
ownership manifest live under `RUNNER_TEMP`. No OIDC/platform credential is
saved there. Proxy mode saves previous proxy variables in its protected manifest.

The Node Action registers an always-running post hook. Normal completion,
failure and startup rollback stop owned processes and remove owned DNS, rules,
routes and links. Cleanup verifies ownership and process creation identity,
is idempotent and reports errors without deleting unrelated state. Transparent
instances use independent resources. Avoid overlapping private DNS domains
across instances: systemd-resolved can query both links.

For early cleanup, check out the same Action source and use `state-file`:

```yaml
- uses: actions/checkout@v4
  with:
    repository: skimasque-dev/connect
    ref: v1 # same coordinated release as the Action
    path: .connect-action
- uses: skimasque-dev/connect@v1
  id: network
  with:
    mode: proxy
    proxy: gateway.example.com:443
    audience: https://gateway.example.com
- run: node .connect-action/src/stop.cjs --state "$STATE_FILE"
  if: always() && steps.network.outputs.state-file != ''
  env:
    STATE_FILE: ${{ steps.network.outputs.state-file }}
```

The later post hook can run again safely. Crashes or forced runner kills can
prevent hooks; use ephemeral dedicated runners, or run `stop.cjs` with the
preserved manifest before reusing a persistent host.

A per-instance `stop.cjs` wrapper beside the manifest also supports
`node /path/to/instance/stop.cjs` while the Action source remains installed.
For a private CA and reproducible downloads, add `ca: ./gateway-ca.pem` and
`version: vX.Y.Z` using an exact client release that includes dual-proxy support.

The gateway lives in [skimasque](https://github.com/skimasque-dev/skimasque).
See [test/linux/README.md](test/linux/README.md) for isolated integration tests.
MIT — see [LICENSE](LICENSE).

## Planned next feature

A named connection profile will let a workflow specify `connection: staging`.
GitHub OIDC will identify the repository, and its authorized control-plane profile
will supply gateway, audience, routes and private DNS settings. This interface is
planned; current workflows use the explicit inputs above.
