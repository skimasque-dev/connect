#!/usr/bin/env bash
set -euo pipefail

# Run inside an outer mount/network/PID namespace, so no runner resolver or
# network configuration can be changed by these privileged tests.
if [[ "${1:-}" != --inside ]]; then
  exec unshare --mount --net --pid --fork --mount-proc bash "$0" --inside
fi
mount --make-rprivate /
mount -t tmpfs tmpfs /run
mkdir -p /run/dbus /run/lock /run/systemd
case_dir=$(mktemp -d /tmp/skimasque-network-case.XXXXXX)
export SKIMASQUE_CASE_DIR="$case_dir"
export SKIMASQUE_TEST_INSIDE=1
script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
cleanup() {
  for space in skm-gateway skm-private skm-public; do
    ip netns pids "$space" 2>/dev/null | xargs -r kill || true
    ip netns del "$space" 2>/dev/null || true
  done
}
trap cleanup EXIT

printf 'nameserver 127.0.0.53\noptions timeout:1 attempts:1\n' > "$case_dir/resolv.conf"
mount --bind "$case_dir/resolv.conf" /etc/resolv.conf
ip link set lo up
dbus-daemon --system --fork
/usr/lib/systemd/systemd-resolved > "$case_dir/resolved.log" 2>&1 &

for space in skm-gateway skm-private skm-public; do
  ip netns add "$space"
  ip -n "$space" link set lo up
done
ip link add rg0 type veth peer name rg1
ip link set rg1 netns skm-gateway
ip addr add 192.0.2.2/24 dev rg0
ip link set rg0 up
ip -n skm-gateway addr add 192.0.2.1/24 dev rg1
ip -n skm-gateway link set rg1 up

ip -n skm-gateway link add gp0 type veth peer name gp1
ip -n skm-gateway link set gp1 netns skm-private
ip -n skm-gateway addr add 10.42.0.1/24 dev gp0
ip -n skm-gateway -6 addr add fd42::1/64 dev gp0 nodad
ip -n skm-gateway link set gp0 up
ip -n skm-private addr add 10.42.0.10/24 dev gp1
ip -n skm-private addr add 10.43.0.53/32 dev gp1
ip -n skm-private -6 addr add fd42::10/64 dev gp1 nodad
ip -n skm-private -6 addr add fd43::53/128 dev gp1 nodad
ip -n skm-private link set gp1 up
ip -n skm-private route add default via 10.42.0.1
ip -n skm-private -6 route add default via fd42::1
ip -n skm-gateway route add 10.43.0.53/32 via 10.42.0.10
ip -n skm-gateway -6 route add fd43::53/128 via fd42::10
ip netns exec skm-gateway sysctl -qw net.ipv4.ip_forward=1

ip link add rp0 type veth peer name rp1
ip link set rp1 netns skm-public
ip addr add 198.51.100.2/24 dev rp0
ip link set rp0 up
ip -n skm-public addr add 198.51.100.10/24 dev rp1
ip -n skm-public link set rp1 up
ip netns exec skm-private python3 "$script_dir/services.py" private > "$case_dir/services.log" 2>&1 &
ip netns exec skm-public python3 "$script_dir/services.py" public > "$case_dir/public.log" 2>&1 &

export SKIMASQUE_TOKEN=network-test-credential
ip netns exec skm-gateway "$SKIMASQUE_SERVER_BIN" \
  --listen 192.0.2.1:4433 --authority localhost:4433 \
  --auth-token network-test-credential \
  --self-signed-name localhost --write-cert "$case_dir/ca.pem" \
  --allow-cidr 10.42.0.0/24 --allow-cidr fd42::/64 \
  --allow-cidr 10.43.0.53/32 --allow-cidr fd43::53/128 \
  --policy-file "$script_dir/policy.toml" > "$case_dir/gateway.log" 2>&1 &
export SKIMASQUE_TEST_GATEWAY_PID=$!
for _ in $(seq 1 100); do
  if [[ -s "$case_dir/ca.pem" ]] && resolvectl status >/dev/null 2>&1; then break; fi
  sleep 0.1
done
[[ -s "$case_dir/ca.pem" ]]
# Exercise the same privilege split as a hosted runner: only network commands
# use sudo; the supervisor and credential-bearing native client are unprivileged.
mkdir "$case_dir/sudoers"
printf 'nobody ALL=(root) NOPASSWD: ALL\n' > "$case_dir/sudoers/integration"
chmod 0440 "$case_dir/sudoers/integration"
mount --bind "$case_dir/sudoers" /etc/sudoers.d
chown nobody "$case_dir"
export SKIMASQUE_CONFIG_HOME="$case_dir"
unset NODE_TEST_CONTEXT
runuser --preserve-environment -u nobody -- node --test "$script_dir/networking.test.cjs"
