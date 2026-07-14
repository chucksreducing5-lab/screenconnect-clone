#!/usr/bin/env node
import https from 'https';
import http from 'http';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function httpGetJson(url, timeoutMs = 10000) {
  const u = new URL(url);
  const lib = u.protocol === 'https:' ? https : http;

  return await new Promise((resolve, reject) => {
    const req = lib.request(
      {
        method: 'GET',
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        timeout: timeoutMs
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
      }
    );

    req.on('timeout', () => req.destroy(new Error(`Timeout after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  const domain = process.argv[2];
  if (!domain) {
    console.error('Usage: verify-reachability.mjs <domain>');
    process.exit(1);
  }

  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    for (const url of [`https://${domain}/health`, `http://${domain}/health`]) {
      try {
        const r = await httpGetJson(url, 8000);
        if (r.statusCode >= 200 && r.statusCode < 500) {
          console.log(`OK: ${url} (${r.statusCode})`);
          return;
        }
      } catch {
        // ignore
      }
    }
    await sleep(5000);
  }

  console.error(`FAILED: ${domain} did not respond on /health within timeout`);
  process.exitCode = 2;
}

main();

