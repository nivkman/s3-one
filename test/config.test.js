import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../src/config.js';
import { contentTypeFor } from '../src/content-type.js';

test('parses an s3:// URL with encoded secret, region and endpoint', () => {
  const { bucket, clientOptions } = resolveConfig(
    's3://AKIA123:abc%2Fdef%2Bghi@my-bucket?region=auto&endpoint=https://acc.r2.cloudflarestorage.com');
  assert.equal(bucket, 'my-bucket');
  assert.equal(clientOptions.region, 'auto');
  assert.equal(clientOptions.endpoint, 'https://acc.r2.cloudflarestorage.com');
  assert.equal(clientOptions.forcePathStyle, true);
  assert.deepEqual(clientOptions.credentials, { accessKeyId: 'AKIA123', secretAccessKey: 'abc/def+ghi' });
});

test('s3://bucket alone uses the default AWS credential chain and virtual-hosted style', () => {
  const { bucket, clientOptions } = resolveConfig('s3://plain-bucket');
  assert.equal(bucket, 'plain-bucket');
  assert.equal(clientOptions.credentials, undefined);
  assert.equal(clientOptions.forcePathStyle, false);
});

test('object config passes extra S3Client options through', () => {
  const { bucket, clientOptions } = resolveConfig({ bucket: 'b', region: 'eu-west-1', maxAttempts: 7 });
  assert.equal(bucket, 'b');
  assert.equal(clientOptions.region, 'eu-west-1');
  assert.equal(clientOptions.maxAttempts, 7);
});

test('falls back to S3_URL, then S3_BUCKET', () => {
  const saved = { url: process.env.S3_URL, bucket: process.env.S3_BUCKET };
  process.env.S3_URL = 's3://from-url';
  assert.equal(resolveConfig().bucket, 'from-url');
  delete process.env.S3_URL;
  process.env.S3_BUCKET = 'from-env';
  assert.equal(resolveConfig().bucket, 'from-env');
  Object.assign(process.env, { S3_URL: saved.url ?? '', S3_BUCKET: saved.bucket ?? '' });
  if (!saved.url) delete process.env.S3_URL;
  if (!saved.bucket) delete process.env.S3_BUCKET;
});

test('rejects a missing bucket and non-s3 URLs with clear errors', () => {
  assert.throws(() => resolveConfig({}), /no bucket/);
  assert.throws(() => resolveConfig('https://example.com/bucket'), /expected an s3:\/\/ URL/);
});

test('content type comes from the file extension', () => {
  assert.equal(contentTypeFor('photos/cat.JPG'), 'image/jpeg');
  assert.equal(contentTypeFor('data.json'), 'application/json');
  assert.equal(contentTypeFor('no-extension'), 'application/octet-stream');
});
