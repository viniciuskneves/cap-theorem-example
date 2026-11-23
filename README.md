# CAP theorem example

A minimal setup to watch the CAP theorem happen: a tiny
replicated key-value API in plain Node.js (no libraries), run as Docker
containers, with a real network partition between them.

## The idea in one minute

The CAP theorem is about three properties of a distributed system:

- **Consistency**: every read sees the latest write. All nodes agree.
- **Availability**: every request to a working node gets a real answer, not an error.
- **Partition tolerance**: the system keeps operating when nodes cannot talk to each other.

Networks do break, so partitions are not optional. The real choice is what to
do **while a partition is happening**:

- **CP**: stay consistent and give up availability. Nodes that cannot be sure
  they have the latest data answer with an error.
- **AP**: stay available and give up consistency. Every node keeps answering,
  possibly with stale data, and conflicting writes are reconciled afterwards.

While the network is healthy you get both, and the two modes look identical.

## How it works

Every node runs the same [`server.js`](server.js) and holds its data in memory.

| Endpoint | What it does |
|---|---|
| `PUT /kv/{key}` | Store the request body as the value |
| `GET /kv/{key}` | Read a value |
| `GET /status` | How this node sees the cluster: reachable peers, whether it has a majority, its data |

The `MODE` environment variable picks the behaviour:

- `MODE=CP`: a read or write succeeds only if a **majority** of the cluster
  takes part. Otherwise the node answers `503`.
- `MODE=AP`: a node always answers from its local state. Nodes exchange state
  in the background, and when two writes conflict the newest one wins
  (last-write-wins).

A partition is created by disconnecting one container from the Docker network
the nodes share. Your machine can still reach every node, so you can see what
each side answers.

## Running the examples

You need Docker with Docker Compose, plus `bash` and `curl`. Nothing else is
installed: the containers use the official `node:22-alpine` image.

Each script runs the same experiment twice, first in CP mode and then in AP
mode, prints every request and response, and removes the containers when it
finishes.

### Example 1: two nodes

```sh
./demo-2nodes.sh
```

The partition separates `node-a` from `node-b`.

| During the partition | CP | AP |
|---|---|---|
| Write on A | `503` | `200` |
| Read on B | `503` | `200`, stale value |
| Write on B | `503` | `200`, now A and B disagree |
| After healing | Both nodes still agree | Newest write wins, the other is lost |

With two nodes a majority is both of them, so in CP mode **the whole system
stops** during a partition.

### Example 2: three nodes

```sh
./demo-3nodes.sh
```

The partition cuts off `node-c`, leaving `node-a` and `node-b` together.

| During the partition | CP | AP |
|---|---|---|
| Write on A, read on B (majority side) | `200` | `200` |
| Read on C (minority side) | `503` | `200`, stale value |
| Write on C (minority side) | `503` | `200`, now the sides disagree |
| After healing | C catches up, all three agree | Newest write wins, even over a write stored on two nodes |

With three nodes a majority is two, so in CP mode **the majority side keeps
working** and only the cut-off node refuses. This is how systems such as etcd
and ZooKeeper behave.

Run one example at a time: both use the container names `node-a` and `node-b`
and the ports 8001 and 8002.

## Playing with it by hand

```sh
# Start three nodes in CP mode (use MODE=AP for the other behaviour)
MODE=CP docker compose -f docker-compose.3nodes.yml up -d --force-recreate

# Write on node-a, read on node-c
curl -X PUT -d hello localhost:8001/kv/greeting
curl localhost:8003/kv/greeting

# Partition: cut node-c off from the other two
docker network disconnect cap-cluster node-c
curl localhost:8001/status
curl localhost:8003/status
curl localhost:8003/kv/greeting

# Heal
docker network connect cap-cluster node-c

# Stop
docker compose -f docker-compose.3nodes.yml down
```

The nodes are on `localhost:8001` (`node-a`), `localhost:8002` (`node-b`) and
`localhost:8003` (`node-c`). For two nodes, use `docker-compose.2nodes.yml` and
disconnect `node-b` instead.

## Files

| File | Purpose |
|---|---|
| [`server.js`](server.js) | The node. Works for any cluster size. |
| [`docker-compose.2nodes.yml`](docker-compose.2nodes.yml) | Two nodes |
| [`docker-compose.3nodes.yml`](docker-compose.3nodes.yml) | Three nodes |
| [`demo-2nodes.sh`](demo-2nodes.sh) | Scripted experiment with two nodes |
| [`demo-3nodes.sh`](demo-3nodes.sh) | Scripted experiment with three nodes |

All of them are heavily commented, since the point is to learn from them.

## What this is not

This is a teaching toy, not a database. Its simplifications are deliberate:

- **Data lives in memory.** Restarting a container wipes it.
- **Versions are wall-clock timestamps.** That works because all containers
  share one machine's clock. Real systems use log positions or logical clocks.
- **CP mode has no consensus protocol.** A write that times out may still have
  been stored on a peer: a timeout means "outcome unknown", not "did not
  happen". Closing that gap needs a leader and a replicated log, which is what
  Raft (etcd) and Zab (ZooKeeper) provide.
