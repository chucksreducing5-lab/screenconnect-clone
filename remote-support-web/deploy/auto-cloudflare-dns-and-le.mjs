#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import dns from 'dns/promises';
import { fileURLToPath } from 'url';
import http from 'http';
import https from 'https';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i++;
  }
  return out;
}

function envOrArg(name, args, fallback = '') {
  return String(args[name] ?? process.env[name] ?? fallback);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function log(...args) {
  console.log(`[auto-dns-le]`, ...args);
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
        res.on('end', () => {
          resolve({ statusCode: res.statusCode, body: data });
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error(`Timeout after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitForHealth(domain, { timeoutMs = 180000, intervalMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;

  while (Date.now() < deadline) {
    for (const url of [`https://${domain}/health`, `http://${domain}/health`]) {
      try {
        const r = await httpGetJson(url, 8000);
        if (r.statusCode && r.statusCode >= 200 && r.statusCode < 500) {
          return { ok: true, url, statusCode: r.statusCode, body: r.body };
        }
      } catch (e) {
        lastErr = e;
      }
    }
    await sleep(intervalMs);
  }

  return { ok: false, error: String(lastErr?.message || 'Health check timed out') };
}

function cfFetch(url, { accountId, apiKey }, init) {
  return fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      // Prefer Bearer token auth; caller may pass either a token or a key.
      'Authorization': `Bearer ${apiKey}`,
      ...(init?.headers || {})
    }
  });
}

async function cloudflareUpsertRecord({
  accountId,
  apiKey,
  zoneId,
  recordName,
  recordType,
  recordTarget,
  ttl = 1,
  proxied = false,
  overwrite = true
}) {
  // List existing records (exact match)
  const listUrl = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?type=${encodeURIComponent(recordType)}&name=${encodeURIComponent(recordName)}`;

  const listRes = await fetch(listUrl, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    }
  });
  const listJson = await listRes.json();

  if (!listJson?.success) {
    throw new Error(`Cloudflare DNS list failed: ${JSON.stringify(listJson)}`);
  }

  const existing = Array.isArray(listJson.result) ? listJson.result : [];
  const match = existing.find((r) => r.name === recordName && r.type === recordType);

  const desired = {
    type: recordType,
    name: recordName,
    content: recordTarget,
    ttl,
    proxied
  };

  if (!match) {
    const createUrl = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`;
    const createRes = await fetch(createUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(desired)
    });
    const createJson = await createRes.json();
    if (!createJson?.success) throw new Error(`Cloudflare DNS create failed: ${JSON.stringify(createJson)}`);
    log(`Created ${recordType} ${recordName} -> ${recordTarget}`);
    return;
  }

  if (!overwrite) {
    log(`DNS record already exists (${recordType} ${recordName}). Not overwriting.`);
    return;
  }

  const updateUrl = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${match.id}`;
  const updateRes = await fetch(updateUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(desired)
  });
  const updateJson = await updateRes.json();
  if (!updateJson?.success) throw new Error(`Cloudflare DNS update failed: ${JSON.stringify(updateJson)}`);
  log(`Updated ${recordType} ${recordName} -> ${recordTarget}`);
}

async function cloudflareFetchJson(url, init, { apiKey, accountId, cfEmail }) {
  const res = await fetch(url, init);
  const json = await res.json();
  return json;
}

async function cloudflareGetZoneId({ apiKey, accountId, zoneName }) {
  // Try by zone name
  const url = `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(zoneName)}`;

  // 1) Bearer auth
  let res = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    }
  });
  let json = await res.json();
  if (json?.success) {
    const zone = (json.result || []).find((z) => z.name === zoneName);
    if (!zone) throw new Error(`Cloudflare zone not found for ${zoneName}`);
    return zone.id;
  }

  // 2) Legacy X-Auth-Email + X-Auth-Key fallback
  const cfEmail = process.env.CLOUDFLARE_EMAIL || 'chucksreducing5@gmail.com';
  const cfKey = apiKey;

  res = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      'X-Auth-Email': cfEmail,
      'X-Auth-Key': cfKey
    }
  });
  json = await res.json();
  if (!json?.success) throw new Error(`Cloudflare zones lookup failed: ${JSON.stringify(json)}`);

  const zone = (json.result || []).find((z) => z.name === zoneName);
  if (!zone) throw new Error(`Cloudflare zone not found for ${zoneName}`);
  return zone.id;
}


async function waitForDnsCname(domain, target, { timeoutMs = 180000, intervalMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const canonical = (await dns.resolveCname(domain)).map((s) => s.replace(/\.$/, ''));
      const normalizedTarget = target.replace(/\.$/, '');
      if (canonical.some((c) => c.toLowerCase() === normalizedTarget.toLowerCase())) {
        return { ok: true, resolved: canonical };
      }
    } catch {
      // ignore
    }
    await sleep(intervalMs);
  }
  return { ok: false };
}

async function main() {
  const args = parseArgs(process.argv);

  const domain = envOrArg('domain', args);
  const tunnelId = envOrArg('tunnel-id', args);
  const cloudflareAccountId = envOrArg('cloudflare-account-id', args);
  const cloudflareApiKey = envOrArg('cloudflare-api-key', args);

  const recordName = envOrArg('recordName', args, domain);
  const recordType = envOrArg('recordType', args, 'CNAME');

  if (!domain) throw new Error('Missing --domain');
  if (!tunnelId) throw new Error('Missing --tunnel-id');
  if (!cloudflareAccountId) throw new Error('Missing --cloudflare-account-id');
  if (!cloudflareApiKey) throw new Error('Missing --cloudflare-api-key');

  const tunnelTarget = `${tunnelId}.cfargotunnel.com`;

  log(`Upserting DNS for ${recordType} ${recordName} -> ${tunnelTarget}`);

  const zoneId = await cloudflareGetZoneId({ apiKey: cloudflareApiKey, accountId: cloudflareAccountId, zoneName: domain });
  await cloudflareUpsertRecord({
    accountId: cloudflareAccountId,
    apiKey: cloudflareApiKey,
    zoneId,
    recordName,
    recordType,
    recordTarget: tunnelTarget,
    ttl: 1,
    proxied: false,
    overwrite: true
  });

  log(`Waiting for DNS propagation...`);
  if (recordType.toUpperCase() === 'CNAME') {
    const r = await waitForDnsCname(recordName, tunnelTarget, { timeoutMs: 180000, intervalMs: 5000 });
    if (!r.ok) log(`DNS propagation check did not confirm CNAME to ${tunnelTarget}. Continuing...`);
  } else {
    log(`Non-CNAME record propagation check not implemented; continuing...`);
  }

  const verify = await waitForHealth(domain, { timeoutMs: 240000, intervalMs: 5000 });
  if (!verify.ok) {
    log(`Health check failed before cert obtain: ${verify.error}`);
  } else {
    log(`Health reachable pre-cert: ${verify.url} (${verify.statusCode})`);
  }

  const obtainScript = path.join(__dirname, 'obtain-lets-encrypt.sh');
  if (!fs.existsSync(obtainScript)) {
    throw new Error(`Missing obtain script: ${obtainScript}`);
  }

  log(`Obtaining Let’s Encrypt cert via ${obtainScript}`);

  await new Promise((resolve, reject) => {
    const proc = spawn('bash', [obtainScript, domain], {
      stdio: 'inherit',
      env: {
        ...process.env,
        CERT_DOMAIN: domain,
        HTTPS_KEY_PATH: path.join(process.cwd(), 'certs', `${domain}-key.pem`),
        HTTPS_CERT_PATH: path.join(process.cwd(), 'certs', `${domain}-cert.pem`)
      }
    });
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`obtain-lets-encrypt.sh exited with code ${code}`));
    });
  });

  log(`Verifying external reachability after cert obtain...`);
  const verify2 = await waitForHealth(domain, { timeoutMs: 240000, intervalMs: 5000 });
  if (!verify2.ok) {
    log(`External reachability FAILED: ${verify2.error}`);
    process.exitCode = 2;
  } else {
    log(`External reachability OK: ${verify2.url} (${verify2.statusCode})`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

