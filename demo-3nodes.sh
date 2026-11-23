#!/usr/bin/env bash
# Three-node version of the experiment: first in CP mode, then in AP mode.
#
# The partition cuts off node-c, splitting the cluster in two sides:
#   majority side: node-a + node-b  (2 of 3)
#   minority side: node-c           (1 of 3)
#
# What is new compared to the two-node demo:
#   CP: the majority side KEEPS WORKING. Only the minority node refuses.
#       After healing, the minority node catches up on what it missed.
#   AP: every node keeps answering, and a write that reached 2 of 3 nodes
#       can still be overwritten by a later write made on the lone node.
set -euo pipefail
cd "$(dirname "$0")"

# This demo uses its own compose file, so every compose command needs "-f".
COMPOSE="docker compose -f docker-compose.3nodes.yml"

# The three nodes, as published on your machine by docker-compose.3nodes.yml.
A=http://localhost:8001
B=http://localhost:8002
C=http://localhost:8003

# Print a bold heading.
say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }

# call <METHOD> <URL> [body]
# Runs one HTTP request and prints: the request, the status code, the response.
call() {
  printf '  %-4s %-32s -> ' "$1" "${2#http://}${3:+  ($3)}"
  curl -s -o /tmp/cap-demo-body -w '%{http_code}  ' -X "$1" ${3:+-d "$3"} "$2" || printf 'ERR  '
  cat /tmp/cap-demo-body 2>/dev/null || echo
}

# Print how each of the three nodes currently sees the cluster.
status_all() { call GET $A/status; call GET $B/status; call GET $C/status; }

# (Re)create the containers in the given mode and wait until all three answer.
# Recreating also wipes their in-memory data, so each experiment starts clean.
start() {
  MODE=$1 $COMPOSE up -d --force-recreate >/dev/null 2>&1
  until curl -sf $A/status >/dev/null && curl -sf $B/status >/dev/null && curl -sf $C/status >/dev/null; do
    sleep 0.3
  done
}

# Cut node-c off from the shared cluster network. node-a and node-b still
# see each other; your machine can still reach all three.
partition() { docker network disconnect cap-cluster node-c; }

# Plug node-c back into the cluster network.
heal()      { docker network connect cap-cluster node-c; }

experiment() {
  say "=== $1 mode, 3 nodes ==="
  start "$1"

  # Both modes behave the same here: no partition, no trade-off.
  say "1. Healthy network: write on A, read on C"
  call PUT $A/kv/x 1
  call GET $C/kv/x

  # Every node sees its two peers and reports "hasMajority": true.
  say "   Status before the partition"
  status_all

  say "2. PARTITION: node-c is cut off from node-a and node-b"
  partition

  # A and B still see each other: 2 of 3, "hasMajority": true.
  # C sees nobody: 1 of 3, "hasMajority": false.
  say "   Status after the partition"
  status_all

  # CP and AP: both succeed, stored on 2 of 3 nodes. In CP this is the big
  # difference from the two-node demo, where this write was refused.
  say "3. Majority side: write on A, read on B"
  call PUT $A/kv/x 2
  call GET $B/kv/x

  # CP: 503. C cannot know that x changed, so it refuses to answer.
  # AP: answers with the old value 1, which is now stale.
  say "4. Minority side: read on C"
  call GET $C/kv/x

  # CP: 503. C alone is not a majority.
  # AP: succeeds, stored on 1 of 3 nodes. The two sides now disagree.
  say "5. Minority side: write a different value on C"
  call PUT $C/kv/x 3

  # CP: all three return 2. C never accepted anything and simply caught up.
  # AP: all three return 3. C's write was the newest, so last-write-wins
  #     discards the 2 that had been stored on a majority of the nodes.
  say "6. HEAL the partition, wait for the nodes to sync, read all three"
  heal
  sleep 3
  call GET $A/kv/x
  call GET $B/kv/x
  call GET $C/kv/x
}

experiment CP
experiment AP

# Stop and remove the containers and networks. Data lives in memory only,
# so nothing is left behind.
say "Cleaning up: docker compose down"
$COMPOSE down >/dev/null 2>&1

say "Done."
