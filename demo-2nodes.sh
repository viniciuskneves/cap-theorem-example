#!/usr/bin/env bash
# Runs the same experiment twice: first in CP mode, then in AP mode.
# Compare the two outputs side by side: the steps are identical, only the
# nodes' behaviour during the partition changes.
set -euo pipefail
cd "$(dirname "$0")"

# This demo uses its own compose file, so every compose command needs "-f".
COMPOSE="docker compose -f docker-compose.2nodes.yml"

# The two nodes, as published on your machine by docker-compose.2nodes.yml.
A=http://localhost:8001
B=http://localhost:8002

# Print a bold heading.
say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }

# call <METHOD> <URL> [body]
# Runs one HTTP request and prints: the request, the status code, the response.
call() {
  printf '  %-4s %-32s -> ' "$1" "${2#http://}${3:+  ($3)}"
  curl -s -o /tmp/cap-demo-body -w '%{http_code}  ' -X "$1" ${3:+-d "$3"} "$2" || printf 'ERR  '
  cat /tmp/cap-demo-body 2>/dev/null || echo
}

# (Re)create both containers in the given mode and wait until they answer.
# Recreating also wipes their in-memory data, so each experiment starts clean.
start() {
  MODE=$1 $COMPOSE up -d --force-recreate >/dev/null 2>&1
  until curl -sf $A/status >/dev/null && curl -sf $B/status >/dev/null; do sleep 0.3; done
}

# Cut node-b off from the shared cluster network: the nodes can no longer
# talk to each other, but your machine can still reach both.
partition() { docker network disconnect cap-cluster node-b; }

# Plug node-b back into the cluster network.
heal()      { docker network connect cap-cluster node-b; }

experiment() {
  say "=== $1 mode ==="
  start "$1"

  # Both modes behave the same here: no partition, no trade-off.
  say "1. Healthy network: write on A, read on B"
  call PUT $A/kv/x 1
  call GET $B/kv/x

  # Each node reports its peer as reachable and "hasMajority": true.
  say "   Status before the partition"
  call GET $A/status
  call GET $B/status

  say "2. PARTITION: node-b is cut off from node-a"
  partition

  # Both nodes are still up and answering you, but neither sees its peer:
  # "reachablePeers" is empty and "hasMajority" is false, in CP and AP alike.
  # The mode only decides what a node DOES about it (steps 3 and 4).
  say "   Status after the partition"
  call GET $A/status
  call GET $B/status

  # CP: both requests fail with 503.
  # AP: the write succeeds on A, and B still answers with the old value.
  say "3. Write on A, read on B"
  call PUT $A/kv/x 2
  call GET $B/kv/x

  # CP: fails with 503.
  # AP: succeeds, so A and B now hold different values for the same key.
  say "4. Write a different value on B"
  call PUT $B/kv/x 3

  # CP: nothing was accepted during the partition, both still have 1.
  # AP: the nodes sync and the newest write (3) wins; the write of 2 is lost.
  say "5. HEAL the partition, wait for the nodes to sync, read both"
  heal
  sleep 3
  call GET $A/kv/x
  call GET $B/kv/x
}

experiment CP
experiment AP

# Stop and remove the containers and networks. Data lives in memory only,
# so nothing is left behind.
say "Cleaning up: docker compose down"
$COMPOSE down >/dev/null 2>&1

say "Done."
