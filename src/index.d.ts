import { S3Client, S3ClientConfig } from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';

export { S3Client };
export * as sdk from '@aws-sdk/client-s3';

/** Seconds. */
export type Seconds = number;

export type Body = string | Uint8Array | Buffer | Blob | Readable | ReadableStream;

export interface S3Config extends Partial<S3ClientConfig> {
  bucket: string;
  region?: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Defaults to true when `endpoint` is set (MinIO, R2, B2...). */
  forcePathStyle?: boolean;
}

export interface ConnectOptions {
  /** Prefix every key with `${prefix}/`. */
  prefix?: string;
  /** Create the bucket when it doesn't exist (handy for MinIO and local dev). */
  createBucket?: boolean;
  /** Base URL for url(), e.g. your CDN or https://pub-xxx.r2.dev */
  publicUrl?: string;
  /** Logger service name (default: 's3-one'). */
  service?: string;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
}

export interface PutOptions {
  /** Detected from the key's extension when omitted. */
  contentType?: string;
  metadata?: Record<string, string>;
  cacheControl?: string;
  contentDisposition?: string;
}

export interface ObjectInfo {
  key: string;
  size: number;
  contentType?: string;
  lastModified: Date;
  etag: string;
  metadata: Record<string, string>;
}

export interface ListItem {
  key: string;
  size: number;
  lastModified: Date;
  etag: string;
}

export class S3One {
  /** The underlying AWS SDK S3Client - full S3 access. */
  readonly client: S3Client;
  readonly bucket: string;
  readonly prefix: string;

  namespace(name: string): S3One;

  put(key: string, body: Body, options?: PutOptions): Promise<{ key: string; etag: string }>;
  putJSON(key: string, value: unknown, options?: PutOptions): Promise<{ key: string; etag: string }>;
  putFile(key: string, filePath: string, options?: PutOptions): Promise<{ key: string; etag: string }>;

  get(key: string): Promise<Buffer | null>;
  getText(key: string): Promise<string | null>;
  getJSON<T = any>(key: string): Promise<T | null>;
  getStream(key: string): Promise<Readable | null>;
  getFile(key: string, filePath: string): Promise<boolean>;
  stat(key: string): Promise<ObjectInfo | null>;
  has(key: string): Promise<boolean>;

  list(prefix?: string, options?: { pageSize?: number }): AsyncGenerator<ListItem>;
  keys(prefix?: string): Promise<string[]>;
  del(...keys: (string | string[])[]): Promise<number>;
  clear(): Promise<number>;
  copy(from: string, to: string): Promise<{ key: string }>;
  move(from: string, to: string): Promise<{ key: string }>;

  /** Temporary download link. `download` makes browsers save it (true = the key's file name). */
  signedUrl(key: string, options?: { ttl?: Seconds; download?: boolean | string }): Promise<string>;
  /** Temporary upload link for a browser PUT. The uploader must send the same Content-Type. */
  signedUploadUrl(key: string, options?: { ttl?: Seconds; contentType?: string }): Promise<string>;
  /** Public URL built from the publicUrl option. */
  url(key: string): string;

  disconnect(): void;
}

export function connectS3(config?: string | S3Config, options?: ConnectOptions): Promise<S3One>;
