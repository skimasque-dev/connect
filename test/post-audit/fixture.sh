#!/usr/bin/env bash
set -euo pipefail
root() { sudo -n env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin "$@"; }
namespace=skm-ci-gateway
if [[ "${1:-}" == cleanup ]]; then
  if root ip netns list | grep -Eq "^$namespace( |$)"; then
    root ip netns pids "$namespace" | xargs -r sudo -n env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin kill
    root ip netns del "$namespace"
  fi
  root ip link delete skm-ci0 2>/dev/null || true
  root iptables -t nat -D POSTROUTING -s 192.0.2.0/24 ! -o skm-ci0 -j MASQUERADE 2>/dev/null || true
  root iptables -D FORWARD -i skm-ci0 -j ACCEPT 2>/dev/null || true
  root iptables -D FORWARD -o skm-ci0 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || true
  if [[ -f "$RUNNER_TEMP/skm-post-audit/ip-forward" ]]; then
    root sysctl -qw "net.ipv4.ip_forward=$(cat "$RUNNER_TEMP/skm-post-audit/ip-forward")"
  fi
  exit
fi
: "${RUNNER_TEMP:?}" "${SKIMASQUE_SERVER_BIN:?}"
directory="$RUNNER_TEMP/skm-post-audit"
mkdir -p "$directory"
cat /proc/sys/net/ipv4/ip_forward > "$directory/ip-forward"
root ip netns add "$namespace"
root ip -n "$namespace" link set lo up
root ip link add skm-ci0 type veth peer name skm-ci1
root ip link set skm-ci1 netns "$namespace"
root ip addr add 192.0.2.2/24 dev skm-ci0
root ip link set skm-ci0 up
root ip -n "$namespace" addr add 192.0.2.1/24 dev skm-ci1
root ip -n "$namespace" link set skm-ci1 up
root ip -n "$namespace" route add default via 192.0.2.2
for ip in 10.42.0.10/32 10.43.0.53/32; do root ip -n "$namespace" addr add "$ip" dev lo; done
for ip in fd42::10/128 fd43::53/128; do root ip -n "$namespace" -6 addr add "$ip" dev lo nodad; done
root mkdir -p "/etc/netns/$namespace"
root cp /run/systemd/resolve/resolv.conf "/etc/netns/$namespace/resolv.conf"
root sysctl -qw net.ipv4.ip_forward=1
root iptables -t nat -A POSTROUTING -s 192.0.2.0/24 ! -o skm-ci0 -j MASQUERADE
root iptables -A FORWARD -i skm-ci0 -j ACCEPT
root iptables -A FORWARD -o skm-ci0 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
root ip netns exec "$namespace" python3 "$script_dir/../linux/services.py" private > "$directory/services.log" 2>&1 &
root ip netns exec "$namespace" python3 -m http.server 18081 --bind 10.42.0.10 > "$directory/origin.log" 2>&1 &
# Gateway itself runs as the runner UID and has normal internet/JWKS access
# through NAT. No runner OIDC environment reaches any privileged command.
root ip netns exec "$namespace" setpriv --reuid="$(id -u)" --regid="$(id -g)" --clear-groups \
  "$SKIMASQUE_SERVER_BIN" --listen 192.0.2.1:4433 --authority localhost:4433 \
  --self-signed-name localhost --write-cert "$directory/ca.pem" \
  --oidc --oidc-audience skimasque-action-ci \
  --allow-cidr 10.42.0.0/24 --allow-cidr fd42::/64 \
  --allow-cidr 10.43.0.53/32 --allow-cidr fd43::53/128 > "$directory/gateway.log" 2>&1 &
for _ in $(seq 1 100); do
  [[ -s "$directory/ca.pem" ]] && break
  sleep 0.1
done
[[ -s "$directory/ca.pem" ]]
