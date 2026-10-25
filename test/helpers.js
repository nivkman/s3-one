import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ACCESS_KEY = 'testkey';
const SECRET = 'test/secret+key';

// Uses S3_TEST_ENDPOINT when set (CI or your own MinIO/SeaweedFS); otherwise
// starts a throwaway SeaweedFS (`weed mini`) if the `weed` binary is on PATH or in WEED_BIN.
export async function startS3() {
  if (process.env.S3_TEST_ENDPOINT) return { endpoint: process.env.S3_TEST_ENDPOINT, ...testCredentials(), stop: () => {} };
  const bin = process.env.WEED_BIN || findWeed();
  const dir = mkdtempSync(join(tmpdir(), 's3-one-'));
  const env = { ...process.env, AWS_ACCESS_KEY_ID: ACCESS_KEY, AWS_SECRET_ACCESS_KEY: SECRET };
  const server = spawn(bin, ['mini', `-dir=${dir}`], { env, stdio: 'ignore' });
  const endpoint = 'http://127.0.0.1:8333';
  await waitForHttp(endpoint);
  return { endpoint, ...testCredentials(), stop: () => { server.kill(); rmSync(dir, { recursive: true, force: true }); } };
}

function testCredentials() {
  return {
    accessKeyId: process.env.S3_TEST_ACCESS_KEY ?? ACCESS_KEY,
    secretAccessKey: process.env.S3_TEST_SECRET ?? SECRET,
  };
}

function findWeed() {
  try {
    return execFileSync('which', ['weed']).toString().trim();
  } catch {
    throw new Error('Tests need an S3 server: set S3_TEST_ENDPOINT, or put SeaweedFS `weed` on PATH / in WEED_BIN');
  }
}

async function waitForHttp(url) {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      await fetch(url);
      return;
    } catch {
      await sleep(250);
    }
  }
  throw new Error(`S3 server did not start at ${url}`);
}
