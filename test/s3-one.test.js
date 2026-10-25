import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { connectS3, S3Client, sdk } from '../src/index.js';
import { startS3 } from './helpers.js';

const BUCKET = `s3-one-test-${process.pid}`;
let server;
let s3;
let files;

function testUrl(bucket = BUCKET) {
  const user = encodeURIComponent(server.accessKeyId);
  const pass = encodeURIComponent(server.secretAccessKey);
  return `s3://${user}:${pass}@${bucket}?endpoint=${encodeURIComponent(server.endpoint)}`;
}

before(async () => {
  server = await startS3();
  s3 = await connectS3(testUrl(), { createBucket: true, logLevel: 'error' });
  files = mkdtempSync(join(tmpdir(), 's3-one-files-'));
});

after(async () => {
  const leftovers = await s3.keys();
  await s3.del(leftovers);
  await s3.client.send(new sdk.DeleteBucketCommand({ Bucket: BUCKET }));
  s3.disconnect();
  rmSync(files, { recursive: true, force: true });
  server.stop();
});

test('connects with one URL and exposes the raw S3Client', async () => {
  assert.ok(s3.client instanceof S3Client);
  assert.equal(s3.bucket, BUCKET);
});

test('fails fast when the bucket does not exist', async () => {
  await assert.rejects(connectS3(testUrl('no-such-bucket-s3-one'), { logLevel: 'error' }), /bucket not found/);
});

test('fails fast with wrong credentials', async () => {
  const bad = `s3://wrong:creds@${BUCKET}?endpoint=${encodeURIComponent(server.endpoint)}`;
  await assert.rejects(connectS3(bad, { logLevel: 'error' }), /cannot access bucket/);
});

test('put/get text, Buffer and JSON', async () => {
  await s3.put('hello.txt', 'hello world');
  assert.equal(await s3.getText('hello.txt'), 'hello world');
  const bytes = Buffer.from([0, 1, 2, 250, 255]);
  await s3.put('bytes.bin', bytes);
  assert.deepEqual(await s3.get('bytes.bin'), bytes);
  await s3.putJSON('user.json', { id: 1, tags: ['a'] });
  assert.deepEqual(await s3.getJSON('user.json'), { id: 1, tags: ['a'] });
});

test('missing objects return null / false instead of throwing', async () => {
  assert.equal(await s3.get('missing'), null);
  assert.equal(await s3.getText('missing'), null);
  assert.equal(await s3.getJSON('missing'), null);
  assert.equal(await s3.getStream('missing'), null);
  assert.equal(await s3.stat('missing'), null);
  assert.equal(await s3.has('missing'), false);
  assert.equal(await s3.getFile('missing', join(files, 'never')), false);
});

test('put refuses plain objects', async () => {
  await assert.rejects(s3.put('obj', { a: 1 }), /putJSON/);
});

test('content type is detected from the key and metadata is stored', async () => {
  await s3.put('img/logo.png', Buffer.from('fake png'), { metadata: { owner: 'niv' }, cacheControl: 'max-age=60' });
  const info = await s3.stat('img/logo.png');
  assert.equal(info.contentType, 'image/png');
  assert.equal(info.size, 8);
  assert.deepEqual(info.metadata, { owner: 'niv' });
  assert.ok(info.lastModified instanceof Date);
  assert.equal(await s3.has('img/logo.png'), true);
  await s3.put('custom', 'x', { contentType: 'text/x-custom' });
  assert.equal((await s3.stat('custom')).contentType, 'text/x-custom');
});

test('streams upload with multipart and download as a stream', async () => {
  const size = 6 * 1024 * 1024 + 123; // > 5 MB part size, so it goes multipart
  const data = Buffer.alloc(size, 7);
  const { etag } = await s3.put('big.bin', Readable.from([data.subarray(0, 3_000_000), data.subarray(3_000_000)]));
  assert.match(etag, /-2"?$/, `expected a 2-part multipart ETag, got ${etag}`);
  assert.equal((await s3.stat('big.bin')).size, size);
  const chunks = [];
  for await (const part of await s3.getStream('big.bin')) chunks.push(part);
  assert.ok(Buffer.concat(chunks).equals(data));
});

test('putFile / getFile round-trip with content type from the file name', async () => {
  const source = join(files, 'report.csv');
  writeFileSync(source, 'a,b\n1,2\n');
  await s3.putFile('reports/2026.csv', source);
  assert.equal((await s3.stat('reports/2026.csv')).contentType, 'text/csv; charset=utf-8');
  const target = join(files, 'nested', 'dir', 'copy.csv');
  assert.equal(await s3.getFile('reports/2026.csv', target), true);
  assert.equal(readFileSync(target, 'utf8'), 'a,b\n1,2\n');
});

test('list pages through results and keys() returns names', async () => {
  const docs = s3.namespace('docs');
  await Promise.all(['a', 'b', 'c', 'd', 'e'].map((name) => docs.put(`${name}.txt`, name)));
  const items = [];
  for await (const item of docs.list('', { pageSize: 2 })) items.push(item);
  assert.deepEqual(items.map((item) => item.key), ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']);
  assert.equal(items[0].size, 1);
  assert.deepEqual(await docs.keys('c'), ['c.txt']);
});

test('namespaces nest and isolate keys', async () => {
  const avatars = s3.namespace('users').namespace('avatars/');
  assert.equal(avatars.prefix, 'users/avatars/');
  await avatars.put('1.png', 'one');
  assert.equal(await s3.getText('users/avatars/1.png'), 'one');
  assert.deepEqual(await avatars.keys(), ['1.png']);
});

test('del removes many keys and batches over 1000', async () => {
  await s3.put('d1', '1');
  await s3.put('d2', '2');
  assert.equal(await s3.del('d1', 'd2'), 2);
  assert.equal(await s3.has('d1'), false);
  const many = Array.from({ length: 1500 }, (_, i) => `ghost-${i}`);
  assert.equal(await s3.del(many), 1500);
  assert.equal(await s3.del(), 0);
});

test('clear() empties only the namespace and refuses on the root', async () => {
  const temp = s3.namespace('temp');
  await temp.put('x', '1');
  await temp.put('y/z', '2');
  await s3.put('keep.txt', 'keep');
  assert.equal(await temp.clear(), 2);
  assert.deepEqual(await temp.keys(), []);
  assert.equal(await s3.has('keep.txt'), true);
  await assert.rejects(s3.clear(), /namespace/);
});

test('copy and move', async () => {
  await s3.put('orig name.txt', 'payload');
  await s3.copy('orig name.txt', 'copied.txt');
  assert.equal(await s3.getText('copied.txt'), 'payload');
  await s3.move('copied.txt', 'archive/moved.txt');
  assert.equal(await s3.has('copied.txt'), false);
  assert.equal(await s3.getText('archive/moved.txt'), 'payload');
});

test('signedUrl downloads the object; download option sets Content-Disposition', async () => {
  await s3.put('share/report.txt', 'secret report');
  const response = await fetch(await s3.signedUrl('share/report.txt', { ttl: 60 }));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'secret report');
  const named = await fetch(await s3.signedUrl('share/report.txt', { download: 'Q3 report.txt' }));
  assert.match(named.headers.get('content-disposition'), /attachment; filename\*=UTF-8''Q3%20report\.txt/);
});

test('signedUrl expires after ttl', async () => {
  await s3.put('expiring.txt', 'soon gone');
  const url = await s3.signedUrl('expiring.txt', { ttl: 1 });
  await sleep(2100);
  assert.equal((await fetch(url)).status, 403);
});

test('signedUploadUrl lets a browser PUT directly to the bucket', async () => {
  const url = await s3.signedUploadUrl('uploads/photo.jpg');
  const response = await fetch(url, { method: 'PUT', body: 'jpeg bytes', headers: { 'Content-Type': 'image/jpeg' } });
  assert.equal(response.status, 200);
  assert.equal(await s3.getText('uploads/photo.jpg'), 'jpeg bytes');
  assert.equal((await s3.stat('uploads/photo.jpg')).contentType, 'image/jpeg');
});

test('signedUploadUrl rejects an upload with a different Content-Type', async () => {
  const url = await s3.signedUploadUrl('uploads/only-png.png');
  const response = await fetch(url, { method: 'PUT', body: '<html>', headers: { 'Content-Type': 'text/html' } });
  assert.equal(response.status, 403);
  assert.equal(await s3.has('uploads/only-png.png'), false);
});

test('url() builds public URLs from publicUrl and refuses without it', async () => {
  const cdn = await connectS3(testUrl(), { publicUrl: 'https://cdn.example.com/', prefix: 'site', logLevel: 'error' });
  assert.equal(cdn.url('img/my cat.png'), 'https://cdn.example.com/site/img/my%20cat.png');
  assert.throws(() => s3.url('x'), /publicUrl/);
  cdn.disconnect();
});

test('prefix option namespaces the root', async () => {
  const app = await connectS3(testUrl(), { prefix: 'app/', logLevel: 'error' });
  await app.put('k.txt', 'v');
  assert.equal(await s3.getText('app/k.txt'), 'v');
  assert.equal(await app.clear(), 1);
  app.disconnect();
});
