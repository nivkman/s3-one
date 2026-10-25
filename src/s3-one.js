import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
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

export function isNotFound(error) {
  return ['NoSuchKey', 'NotFound', 'NoSuchBucket'].includes(error?.name) || error?.$metadata?.httpStatusCode === 404;
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
    return new S3One(this.#core, `${this.#prefix}${name.replace(/\/+$/, '')}/`);
  }

  // ---- Write -------------------------------------------------------------

  async put(key, body, options = {}) {
    checkBody(body);
    const params = this.#putParams(key, body, options);
    const result = isStream(body)
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

  async getFile(key, filePath) {
    const body = await this.#getBody(key);
    if (!body) return false;
    await mkdir(dirname(filePath), { recursive: true });
    await pipeline(body, createWriteStream(filePath));
    return true;
  }

  async stat(key) {
    try {
      return toObjectInfo(key, await this.client.send(new HeadObjectCommand(this.#params(key))));
    } catch (error) {
      if (isNotFound(error)) return null;
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

  async del(...keys) {
    for (const batch of chunk(keys.flat(), DELETE_BATCH)) {
      const Objects = batch.map((key) => ({ Key: this.#key(key) }));
      await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects, Quiet: true } }));
    }
    return keys.flat().length;
  }

  // Deletes every object in this namespace. Refuses on the root to avoid emptying the bucket.
  async clear() {
    if (!this.#prefix) throw new Error('s3-one: clear() only works on a namespace');
    return this.del(await this.keys());
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
    return getSignedUrl(this.client, command, { expiresIn: Math.round(ttl) });
  }

  // The uploader must send the same Content-Type header - it is part of the signature.
  async signedUploadUrl(key, { ttl = 900, contentType = contentTypeFor(key) } = {}) {
    const command = new PutObjectCommand({ ...this.#params(key), ContentType: contentType });
    const signableHeaders = new Set(['content-type']);
    return getSignedUrl(this.#uploadSigner(), command, { expiresIn: Math.round(ttl), signableHeaders });
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
      if (isNotFound(error)) return null;
      throw error;
    }
  }
}
