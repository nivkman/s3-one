import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, basename } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectsCommand,
  ListObjectsV2Command, CopyObjectCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { contentTypeFor } from './content-type.js';

const DELETE_BATCH = 1000;
const MAX_SIGNED_TTL = 7 * 24 * 3600;

// Object-level "missing". NoSuchBucket is deliberately not here: a deleted bucket must not look like "no data".
// (HEAD responses have no body, so HeadObject on a missing bucket still reads as NotFound.)
export function isMissingObject(error) {
  return error?.name === 'NoSuchKey' || error?.name === 'NotFound';
}

export class DeleteError extends Error {
  constructor(errors) {
    super(`s3-one: could not delete ${errors.length} object(s): ${errors.slice(0, 3).map((e) => `${e.Key} (${e.Code})`).join(', ')}`);
    this.name = 'DeleteError';
    this.errors = errors;
  }
}

function isStream(body) {
  return body instanceof Readable || body instanceof ReadableStream;
}

function checkBody(body) {
  const ok = typeof body === 'string' || body instanceof Uint8Array || body instanceof Blob || isStream(body);
  if (!ok) throw new TypeError('s3-one: body must be a string, Buffer, Uint8Array, Blob or stream (use putJSON for objects)');
}

function toObjectInfo(key, head) {
  return {
    key,
    size: head.ContentLength,
    contentType: head.ContentType,
    lastModified: head.LastModified,
    etag: head.ETag,
    metadata: head.Metadata ?? {},
  };
}

async function toUploadable(body) {
  return body instanceof Blob ? Buffer.from(await body.arrayBuffer()) : body;
}

function checkTtl(ttl) {
  if (!(ttl >= 1 && ttl <= MAX_SIGNED_TTL)) throw new RangeError(`s3-one: ttl must be between 1 and ${MAX_SIGNED_TTL} seconds (7 days)`);
  return Math.round(ttl);
}

function contentDisposition(download, key) {
  if (!download) return undefined;
  const name = download === true ? basename(key) : download;
  return `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function chunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

export class S3One {
  #core = null;
  #prefix = '';

  // core is shared by every namespace: { client, clientOptions, logger, bucket, publicUrl }
  constructor(core, prefix = '') {
    this.#core = core;
    this.#prefix = prefix;
  }

  get client() {
    return this.#core.client;
  }

  get bucket() {
    return this.#core.bucket;
  }

  get prefix() {
    return this.#prefix;
  }

  namespace(name) {
    const clean = String(name).replace(/^\/+|\/+$/g, '');
    if (!clean) throw new Error('s3-one: namespace() needs a non-empty name');
    return new S3One(this.#core, `${this.#prefix}${clean}/`);
  }

  // ---- Write -------------------------------------------------------------

  async put(key, body, options = {}) {
    checkBody(body);
    const params = this.#putParams(key, await toUploadable(body), options);
    const result = isStream(params.Body)
      ? await new Upload({ client: this.client, params }).done()
      : await this.client.send(new PutObjectCommand(params));
    this.#core.logger.debug(`PUT ${params.Key}`);
    return { key, etag: result.ETag };
  }

  async putJSON(key, value, options = {}) {
    return this.put(key, JSON.stringify(value), { contentType: 'application/json', ...options });
  }

  async putFile(key, filePath, options = {}) {
    return this.put(key, createReadStream(filePath), { contentType: contentTypeFor(filePath), ...options });
  }

  // ---- Read --------------------------------------------------------------

  async get(key) {
    const body = await this.#getBody(key);
    return body && Buffer.from(await body.transformToByteArray());
  }

  async getText(key) {
    const body = await this.#getBody(key);
    return body && body.transformToString();
  }

  async getJSON(key) {
    const text = await this.getText(key);
    return text === null ? null : JSON.parse(text);
  }

  async getStream(key) {
    return this.#getBody(key);
  }

  // Downloads to a temp file first, so a failed download never leaves a half-written file behind.
  async getFile(key, filePath) {
    const body = await this.#getBody(key);
    if (!body) return false;
    await mkdir(dirname(filePath), { recursive: true });
    const partial = `${filePath}.${process.pid}.partial`;
    try {
      await pipeline(body, createWriteStream(partial));
      await rename(partial, filePath);
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
    return true;
  }

  async stat(key) {
    try {
      return toObjectInfo(key, await this.client.send(new HeadObjectCommand(this.#params(key))));
    } catch (error) {
      if (isMissingObject(error)) return null;
      throw error;
    }
  }

  async has(key) {
    return (await this.stat(key)) !== null;
  }

  // ---- List / delete / copy ---------------------------------------------

  async *list(prefix = '', { pageSize } = {}) {
    let ContinuationToken;
    do {
      const page = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket, Prefix: this.#key(prefix), ContinuationToken, MaxKeys: pageSize }));
      for (const item of page.Contents ?? []) yield this.#toListItem(item);
      ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (ContinuationToken);
  }

  async keys(prefix = '') {
    const keys = [];
    for await (const item of this.list(prefix)) keys.push(item.key);
    return keys;
  }

  // Throws DeleteError (with .errors per key) when S3 refuses some keys, e.g. an IAM policy denies them.
  async del(...keys) {
    const all = keys.flat();
    for (const batch of chunk(all, DELETE_BATCH)) await this.#deleteBatch(batch);
    return all.length;
  }

  // Deletes every object in this namespace, page by page. Refuses on the root to avoid emptying the bucket.
  async clear() {
    if (!this.#prefix) throw new Error('s3-one: clear() only works on a namespace');
    let deleted = 0;
    let batch = [];
    for await (const { key } of this.list()) {
      batch.push(key);
      if (batch.length === DELETE_BATCH) deleted += await this.del(batch.splice(0));
    }
    return deleted + (await this.del(batch));
  }

  async copy(from, to) {
    const CopySource = encodeURIComponent(`${this.bucket}/${this.#key(from)}`);
    await this.client.send(new CopyObjectCommand({ ...this.#params(to), CopySource }));
    return { key: to };
  }

  async move(from, to) {
    await this.copy(from, to);
    await this.del(from);
    return { key: to };
  }

  // ---- URLs --------------------------------------------------------------

  async signedUrl(key, { ttl = 900, download } = {}) {
    const ResponseContentDisposition = contentDisposition(download, key);
    const command = new GetObjectCommand({ ...this.#params(key), ResponseContentDisposition });
    return getSignedUrl(this.client, command, { expiresIn: checkTtl(ttl) });
  }

  // The uploader must send the same Content-Type header - it is part of the signature.
  async signedUploadUrl(key, { ttl = 900, contentType = contentTypeFor(key) } = {}) {
    const command = new PutObjectCommand({ ...this.#params(key), ContentType: contentType });
    const signableHeaders = new Set(['content-type']);
    return getSignedUrl(this.#uploadSigner(), command, { expiresIn: checkTtl(ttl), signableHeaders });
  }

  url(key) {
    const { publicUrl } = this.#core;
    if (!publicUrl) throw new Error('s3-one: url() needs the publicUrl option (e.g. your CDN or r2.dev domain)');
    const path = this.#key(key).split('/').map(encodeURIComponent).join('/');
    return `${publicUrl.replace(/\/+$/, '')}/${path}`;
  }

  // ---- Lifecycle ---------------------------------------------------------

  disconnect() {
    this.client.destroy();
    this.#core.uploadSigner?.destroy();
    this.#core.logger.info('S3 client closed');
  }

  // ---- Internals ---------------------------------------------------------

  #key(key) {
    return `${this.#prefix}${key}`;
  }

  // The default client would sign a CRC32 of an empty body into upload URLs, so every
  // real upload fails with BadDigest. A second client that skips optional checksums signs them.
  #uploadSigner() {
    const core = this.#core;
    core.uploadSigner ??= new S3Client({ ...core.clientOptions, requestChecksumCalculation: 'WHEN_REQUIRED' });
    return core.uploadSigner;
  }

  #params(key) {
    return { Bucket: this.bucket, Key: this.#key(key) };
  }

  #putParams(key, body, { contentType, metadata, cacheControl, contentDisposition: disposition }) {
    return {
      ...this.#params(key),
      Body: body,
      ContentType: contentType ?? contentTypeFor(key),
      Metadata: metadata,
      CacheControl: cacheControl,
      ContentDisposition: disposition,
    };
  }

  #toListItem(item) {
    return { key: item.Key.slice(this.#prefix.length), size: item.Size, lastModified: item.LastModified, etag: item.ETag };
  }

  async #getBody(key) {
    try {
      return (await this.client.send(new GetObjectCommand(this.#params(key)))).Body;
    } catch (error) {
      if (isMissingObject(error)) return null;
      throw error;
    }
  }

  async #deleteBatch(keys) {
    const Objects = keys.map((key) => ({ Key: this.#key(key) }));
    const result = await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects, Quiet: true } }));
    if (result.Errors?.length) throw new DeleteError(result.Errors);
  }
}
