# Real networking verification

This suite uses real client/server binaries with embedded tun-rs/smoltcp, Linux TUN,
iproute2 and systemd-resolved. An outer mount/network/PID namespace isolates
the test from the host. Nested namespaces separate runner, gateway, private
services/DNS and public services. Never run the fixture on a shared runner.

Build the matching native-capable client with Rust 1.88 or later. On dedicated Ubuntu:

```sh
sudo --preserve-env=SKIMASQUE_CLIENT_BIN,SKIMASQUE_SERVER_BIN \
  node --test test/linux/networking.test.cjs
```

Set those two variables to absolute binary paths. Install iproute2, dbus,
systemd-resolved and Python 3. The CI workflow uses a disposable
privileged container built from `Dockerfile`, so resolver changes remain inside
that container and the outer test namespace.

Coverage includes raw private TCP with both families, private DNS outside the
configured CIDRs, hostname A/AAAA resolution, UDP DNS, TCP DNS, policy refusal,
unchanged public routes, native client and gateway failure with a usable underlying private route,
idempotent explicit cleanup and the same post entrypoint used by GitHub Actions.
Portable tests additionally inject failures before every network mutation,
preserve unrelated state, reject foreign ownership, verify concurrent resources,
validate process creation identity and restore all proxy variables.

The real namespace suite also SIGKILLs setup after an actual TUN mutation and
verifies saved-manifest post recovery. A kernel-held host lock releases on
process death; a clean helper finishes any current mutation before release.

The workflow also runs the actual Action and its registered post hook with
GitHub OIDC in both modes, with successful and intentionally failed workloads.
A separate post audit registers first so it runs
after the Action's post. That job requires `id-token: write` and is skipped for
fork pull requests. Cross-repository CI uses `vars.SKIMASQUE_CLIENT_REF` (default
`main`) or the manual `client-ref` input; point it at the matching client commit
until that branch lands. Publishing either repository is a separate operation.

Smoke jobs restore Rust caches with read-only cache tokens. A separate workflow
populates the cache on pushes to `main`, building the fixed client `main` ref.
PRs and manual client-ref runs can reuse it without writing shared cache entries.
The cache uses a new namespace to avoid consuming entries from the old policy;
it becomes warm after the first successful trusted build.
