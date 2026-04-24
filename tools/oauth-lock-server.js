const http = require("http");

const PORT = Number(process.env.OAUTH_LOCK_PORT || 17666);
const HOST = process.env.OAUTH_LOCK_HOST || "127.0.0.1";
const DEFAULT_TTL_MS = Number(process.env.OAUTH_LOCK_TTL_MS || 10 * 60 * 1000);

let current = null;
let queue = [];

function now() {
  return Date.now();
}

function removeFromQueue(ownerId) {
  queue = queue.filter((item) => item.ownerId !== ownerId);
}

function cleanupExpiredLock() {
  if (current && current.expiresAt <= now()) {
    console.log("[oauth-lock] expired:", current.ownerId, current.meta || {});
    current = null;
  }
}

function ensureQueued(ownerId, meta = {}) {
  if (queue.some((item) => item.ownerId === ownerId)) return;
  queue.push({ ownerId, meta, queuedAt: now() });
}

function readJson(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    return sendJson(res, 200, { ok: true });
  }

  cleanupExpiredLock();

  if (req.method === "GET" && req.url === "/status") {
    return sendJson(res, 200, {
      ok: true,
      locked: Boolean(current),
      current: current
        ? {
            ownerId: current.ownerId,
            meta: current.meta,
            expiresAt: current.expiresAt,
            remainingMs: Math.max(0, current.expiresAt - now()),
          }
        : null,
      queue: queue.map((item, index) => ({
        position: index + 1,
        ownerId: item.ownerId,
        meta: item.meta,
        queuedAt: item.queuedAt,
      })),
    });
  }

  if (req.method === "POST" && req.url === "/acquire") {
    const body = await readJson(req);
    const ownerId = body.ownerId;
    const ttlMs = Number(body.ttlMs || DEFAULT_TTL_MS);
    const meta = body.meta || {};

    if (!ownerId) {
      return sendJson(res, 400, { ok: false, error: "missing ownerId" });
    }

    if (current && current.ownerId === ownerId) {
      current.expiresAt = now() + ttlMs;
      return sendJson(res, 200, {
        ok: true,
        granted: true,
        ownerId,
        expiresAt: current.expiresAt,
        alreadyOwned: true,
      });
    }

    ensureQueued(ownerId, meta);

    if (!current && queue[0]?.ownerId === ownerId) {
      queue.shift();
      current = {
        ownerId,
        meta,
        acquiredAt: now(),
        expiresAt: now() + ttlMs,
      };
      console.log("[oauth-lock] acquired:", ownerId, meta);
      return sendJson(res, 200, {
        ok: true,
        granted: true,
        ownerId,
        expiresAt: current.expiresAt,
      });
    }

    const position = queue.findIndex((item) => item.ownerId === ownerId) + 1;
    return sendJson(res, 200, {
      ok: true,
      granted: false,
      position,
      queueLength: queue.length,
      currentOwnerId: current?.ownerId || null,
      currentMeta: current?.meta || null,
      retryAfterMs: 3000,
      remainingMs: current ? Math.max(0, current.expiresAt - now()) : 0,
    });
  }

  if (req.method === "POST" && req.url === "/renew") {
    const body = await readJson(req);
    const ownerId = body.ownerId;
    const ttlMs = Number(body.ttlMs || DEFAULT_TTL_MS);

    if (current && current.ownerId === ownerId) {
      current.expiresAt = now() + ttlMs;
      return sendJson(res, 200, {
        ok: true,
        renewed: true,
        expiresAt: current.expiresAt,
      });
    }

    return sendJson(res, 409, {
      ok: false,
      renewed: false,
      error: "lock not owned by this ownerId",
    });
  }

  if (req.method === "POST" && req.url === "/release") {
    const body = await readJson(req);
    const ownerId = body.ownerId;

    removeFromQueue(ownerId);

    if (current && current.ownerId === ownerId) {
      console.log("[oauth-lock] released:", ownerId, body.reason || "");
      current = null;
      return sendJson(res, 200, { ok: true, released: true });
    }

    return sendJson(res, 200, { ok: true, released: false });
  }

  return sendJson(res, 404, { ok: false, error: "not found" });
});

server.listen(PORT, HOST, () => {
  console.log(`[oauth-lock] listening at http://${HOST}:${PORT}`);
});
