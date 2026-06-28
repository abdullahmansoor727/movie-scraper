import http from "node:http";

const PROXY_BASE = process.env.PROXY_BASE || "http://localhost:8888";
const PROXY_PATH = process.env.PROXY_PATH || "/api/segment.ts";
const CHUNK_SIZE = 32 * 1024;
const CHUNK_COUNT = 32;
const CHUNK_DELAY_MS = 50;
const UPSTREAM_PORT = Number(process.env.UPSTREAM_PORT || 9876);

function startSlowUpstream() {
  const payload = Buffer.alloc(CHUNK_SIZE * CHUNK_COUNT, 0xab);
  return new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, {
        "Content-Type": "video/mp2t",
        "Content-Length": String(payload.length),
      });
      let offset = 0;
      const sendChunk = () => {
        if (offset >= payload.length) {
          res.end();
          return;
        }
        const end = Math.min(offset + CHUNK_SIZE, payload.length);
        res.write(payload.subarray(offset, end));
        offset = end;
        setTimeout(sendChunk, CHUNK_DELAY_MS);
      };
      sendChunk();
    });
    server.on("error", reject);
    server.listen(UPSTREAM_PORT, "127.0.0.1", () => resolve(server));
  });
}

async function measure(label, url) {
  const started = performance.now();
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${label} failed: HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  let firstByteMs = null;
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (firstByteMs === null) firstByteMs = performance.now() - started;
    totalBytes += value.byteLength;
  }
  const totalMs = performance.now() - started;
  return {
    label,
    firstByteMs: Math.round(firstByteMs ?? totalMs),
    totalMs: Math.round(totalMs),
    totalBytes,
  };
}

const upstreamUrl = `http://127.0.0.1:${UPSTREAM_PORT}/segment.ts`;
const proxyUrl = `${PROXY_BASE}${PROXY_PATH}?url=${encodeURIComponent(upstreamUrl)}`;

const server = await startSlowUpstream();
try {
  const direct = await measure("direct upstream", upstreamUrl);
  const proxy = await measure("streaming proxy", proxyUrl);
  console.log(JSON.stringify({ direct, proxy }, null, 2));
  const ok =
    proxy.firstByteMs < direct.totalMs * 0.25 &&
    Math.abs(proxy.totalMs - direct.totalMs) <= 250;
  if (!ok) {
    console.error("Benchmark failed: proxy still looks buffered");
    process.exitCode = 1;
  } else {
    console.log("Benchmark passed: proxy streams first byte early");
  }
} finally {
  await new Promise((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
}
