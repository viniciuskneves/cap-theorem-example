// A tiny replicated key-value node. Zero dependencies: only Node built-ins.
//
// Every node runs this same file. A node knows its peers through the PEERS
// environment variable, and the cluster can be any size (2 nodes, 3 nodes...).
//
// MODE=CP -> a request only succeeds if a MAJORITY of the cluster takes part.
//            During a partition, nodes that cannot reach a majority answer 503.
//            (Consistent, but not available.)
//
// MODE=AP -> a request always succeeds using local state.
//            During a partition, nodes may return stale data and accept
//            conflicting writes, which are reconciled after healing.
//            (Available, but not consistent.)

const http = require('node:http');
const dns = require('node:dns');

// ---------- configuration ----------

const NAME = process.env.NODE_NAME || 'node';
const MODE = (process.env.MODE || 'CP').toUpperCase();
const PORT = Number(process.env.PORT || 8000);

// Comma-separated list of the OTHER nodes, e.g. "http://node-b:8000,http://node-c:8000"
const PEERS = (process.env.PEERS || '').split(',').map((p) => p.trim()).filter(Boolean);

// The cluster is this node plus its peers.
const CLUSTER_SIZE = PEERS.length + 1;

// "More than half". 2 nodes -> 2, 3 nodes -> 2, 4 nodes -> 3, 5 nodes -> 3.
// Any two majorities share at least one node, so two sides of a partition can
// never both have one. That is what makes it safe to keep working.
const MAJORITY = Math.floor(CLUSTER_SIZE / 2) + 1;

// How long we wait for a peer before treating it as unreachable.
const PEER_TIMEOUT_MS = 500;

// How often nodes exchange their full state to catch up with each other.
const SYNC_INTERVAL_MS = 2000;

// ---------- state ----------

// The whole "database": key -> { value, ts, node }
//   value: what the client stored
//   ts:    when it was written (milliseconds), used to decide which write is newer
//   node:  which node accepted the write, used as a tie-breaker
const store = new Map();

// Last-write-wins: the entry with the highest timestamp survives.
// Ties are broken by node name so every node picks the same winner.
// NOTE: this trusts wall clocks. It works here because all containers share
// your machine's clock; real systems use log positions or logical clocks.
function merge(key, incoming) {
  if (!incoming) return;
  const current = store.get(key);
  const incomingWins =
    !current ||
    incoming.ts > current.ts ||
    (incoming.ts === current.ts && incoming.node > current.node);
  if (incomingWins) store.set(key, incoming);
}

// ---------- talking to peers ----------

// Turn a peer's hostname into an IP address by asking the DNS server directly.
//
// Why not Node's default lookup? The default runs on a pool of only 4 threads
// and blocks one of them until the system resolver gives up. During a
// partition the cut-off node's name no longer resolves, and on some Docker
// setups (Linux, for one) each attempt hangs for seconds. A few of those fill
// the pool, lookups for HEALTHY peers get stuck in the queue behind them, and
// the node wrongly concludes that everyone is unreachable.
// dns.resolve4 does not use that pool, so a slow lookup only delays itself.
function lookupPeer(hostname, options, callback) {
  dns.resolve4(hostname, (err, addresses) => {
    if (err) return callback(err);
    // Depending on its settings, Node asks for one address or for all of them.
    if (options.all) return callback(null, addresses.map((address) => ({ address, family: 4 })));
    callback(null, addresses[0], 4);
  });
}

// Send one request to one peer and resolve with its JSON reply.
// Rejects if the peer is unreachable, too slow, or answers with an error.
//
// One fresh connection per call (agent: false). A reused keep-alive connection
// would let the kernel keep retrying a request we already gave up on, and
// deliver it after the partition heals.
function callPeer(peer, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      peer + path,
      {
        method: 'POST',
        agent: false,
        lookup: lookupPeer,
        headers: { 'content-type': 'application/json' },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () =>
          res.statusCode === 200
            ? resolve(JSON.parse(data))
            : reject(new Error(`peer answered ${res.statusCode}`)),
        );
      },
    );
    const timer = setTimeout(() => req.destroy(new Error('peer timeout')), PEER_TIMEOUT_MS);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
    req.end(JSON.stringify(body ?? {}));
  });
}

// Send the same request to ALL peers in parallel.
// Returns only the replies that arrived: [{ peer, reply }, ...].
// Unreachable peers are simply missing from the result.
async function askPeers(path, body) {
  const attempts = PEERS.map((peer) =>
    callPeer(peer, path, body).then(
      (reply) => ({ peer, reply }),
      () => null, // unreachable -> no reply
    ),
  );
  return (await Promise.all(attempts)).filter(Boolean);
}

// This node always counts as one participant, so a majority is reached when
// "me + the peers that answered" is at least MAJORITY.
const isMajority = (peerReplies) => 1 + peerReplies.length >= MAJORITY;

// ---------- public API ----------

async function putKey(key, value) {
  const entry = { value, ts: Date.now(), node: NAME };

  if (MODE === 'CP') {
    // Ask every peer to store the entry and count how many acknowledged.
    const acks = await askPeers('/internal/replicate', { key, entry });

    // Without a majority we must refuse: the nodes we cannot see might be
    // forming their own majority and accepting other writes.
    if (!isMajority(acks)) {
      return [503, { error: `no majority (${1 + acks.length}/${CLUSTER_SIZE}): refusing write to stay consistent` }];
    }

    // A majority has it, so the write is safe. Store it locally too.
    // KNOWN SIMPLIFICATION: a peer that stored the entry keeps it even if we
    // end up refusing here (e.g. its acknowledgement got lost). A timeout
    // means "outcome unknown", not "did not happen". Closing that gap is what
    // consensus protocols such as Raft are for.
    merge(key, entry);
    return [200, { key, value, storedOn: `${1 + acks.length}/${CLUSTER_SIZE} nodes` }];
  }

  // AP: accept locally no matter what, then replicate on a best-effort basis.
  // Peers we cannot reach now will receive the entry later through syncWithPeers().
  merge(key, entry);
  const acks = await askPeers('/internal/replicate', { key, entry });
  return [200, { key, value, storedOn: `${1 + acks.length}/${CLUSTER_SIZE} nodes` }];
}

async function getKey(key) {
  if (MODE === 'CP') {
    // Ask every peer for its copy of this key.
    const replies = await askPeers('/internal/read', { key });

    // Without a majority we cannot know whether a newer value exists on the
    // other side of the partition, so we refuse rather than risk a stale answer.
    if (!isMajority(replies)) {
      return [503, { error: `no majority (${1 + replies.length}/${CLUSTER_SIZE}): refusing read, value could be stale` }];
    }

    // Any majority contains at least one node holding the latest write.
    // Merging every reply into our store leaves us with the newest entry
    // ("read repair": a node that fell behind catches up while reading).
    for (const { reply } of replies) merge(key, reply.entry);
  }

  // AP skips all of the above and simply answers from local state.
  const entry = store.get(key);
  if (!entry) return [404, { error: 'key not found' }];
  return [200, { key, value: entry.value, writtenBy: entry.node }];
}

// A snapshot of how this node sees the cluster. Handy for watching a partition.
async function status() {
  const reachable = await askPeers('/internal/ping');
  return [
    200,
    {
      mode: MODE,
      clusterSize: CLUSTER_SIZE,
      majorityNeeded: MAJORITY,
      reachablePeers: reachable.map(({ peer }) => new URL(peer).hostname),
      hasMajority: isMajority(reachable),
      data: Object.fromEntries([...store].map(([k, e]) => [k, e.value])),
    },
  ];
}

// ---------- background catch-up ----------

// Periodically exchange full state with every reachable peer ("anti-entropy").
// We send everything we have, each peer merges it and replies with everything
// it has, and we merge that. After a partition heals, this is what makes the
// nodes converge again:
//   AP: conflicting writes meet here and last-write-wins picks the survivor.
//   CP: a node that was cut off receives the writes it missed.
async function syncWithPeers() {
  const replies = await askPeers('/internal/sync', { entries: Object.fromEntries(store) });
  for (const { reply } of replies) {
    for (const [key, entry] of Object.entries(reply.entries)) merge(key, entry);
  }
}

// ---------- HTTP plumbing ----------

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// Maps a request to a handler. Every handler returns [httpStatus, jsonBody].
async function route(req) {
  const { pathname } = new URL(req.url, 'http://localhost');
  const key = pathname.startsWith('/kv/') ? decodeURIComponent(pathname.slice(4)) : null;

  // Endpoints for clients (you, with curl)
  if (key && req.method === 'PUT') return putKey(key, await readBody(req));
  if (key && req.method === 'GET') return getKey(key);
  if (pathname === '/status' && req.method === 'GET') return status();

  // Endpoints for other nodes. They only touch local state and never call
  // further peers, otherwise nodes would call each other in circles.
  if (req.method === 'POST' && pathname.startsWith('/internal/')) {
    const body = JSON.parse((await readBody(req)) || '{}');

    // "Are you there?"
    if (pathname === '/internal/ping') return [200, { ok: true }];

    // "Store this entry."
    if (pathname === '/internal/replicate') {
      merge(body.key, body.entry);
      return [200, { ok: true }];
    }

    // "What is your copy of this key?"
    if (pathname === '/internal/read') {
      return [200, { entry: store.get(body.key) ?? null }];
    }

    // "Here is everything I have; send me everything you have."
    if (pathname === '/internal/sync') {
      for (const [k, entry] of Object.entries(body.entries)) merge(k, entry);
      return [200, { entries: Object.fromEntries(store) }];
    }
  }

  return [404, { error: 'not found' }];
}

http
  .createServer(async (req, res) => {
    let code, body;
    try {
      [code, body] = await route(req);
    } catch (err) {
      [code, body] = [500, { error: String(err.message || err) }];
    }
    res.writeHead(code, { 'content-type': 'application/json' });
    // Every response says which node produced it.
    res.end(JSON.stringify({ node: NAME, ...body }) + '\n');
  })
  .listen(PORT, () =>
    console.log(`${NAME} listening on :${PORT} in ${MODE} mode, cluster of ${CLUSTER_SIZE}, majority is ${MAJORITY}`),
  );

setInterval(syncWithPeers, SYNC_INTERVAL_MS);

// Node runs as PID 1 inside the container and would otherwise ignore SIGTERM,
// making "docker compose down" wait 10 seconds before killing it.
process.on('SIGTERM', () => process.exit(0));
