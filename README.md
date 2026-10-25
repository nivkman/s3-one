# s3-one ☁️

S3 in one line of code. Put and get text, JSON, files and streams, create signed URLs, list, copy, move and namespace — on AWS S3, Cloudflare R2, MinIO, Backblaze B2, DigitalOcean Spaces, SeaweedFS or any S3-compatible storage. The full AWS SDK is still there when you need it.

```js
import { connectS3 } from 's3-one';

const s3 = await connectS3(process.env.S3_URL);

await s3.put('avatars/1.png', buffer);
const link = await s3.signedUrl('avatars/1.png', { ttl: 300 });
```

## Features ✨

- ⚡ **One-line Connection** - One `s3://key:secret@bucket?endpoint=…` URL, an options object, or the standard AWS env vars
- 🌍 **Any S3-compatible Storage** - AWS, Cloudflare R2, MinIO, B2, Spaces, Wasabi, SeaweedFS
- 📦 **Text, JSON, Buffers, Files and Streams** - `getJSON`, `putFile`, `getFile`, `getStream`
- 🔎 **Missing = `null`** - No more `try/catch` for `NoSuchKey`
- 🏷️ **Automatic Content-Type** - Detected from the file extension, so browsers render images and PDFs
- 🚀 **Multipart Uploads** - Streams of any size are uploaded in parts automatically
- 🔗 **Signed URLs** - Temporary download links (optionally as an attachment) and browser upload links
- 📜 **Paginated Listing** - `for await (const item of s3.list('photos/'))` walks every page for you
- 🗂️ **Namespaces** - `s3.namespace('users')` scopes keys, listing and `clear()`
- ✅ **Fails Fast** - Checks the bucket and credentials on connect, not on your first upload
- 🔌 **Full SDK Access** - `s3.client` is the raw `S3Client`, and `sdk` re-exports every command
- 🎯 **TypeScript Types** - Bundled `.d.ts`, no build step

## Installation

```bash
npm install s3-one
```

Requires Node.js 20+.

## Quick Start

```js
import { connectS3 } from 's3-one';

const s3 = await connectS3('s3://ACCESS_KEY:SECRET@my-bucket?region=us-east-1');

// Write
await s3.put('notes/hello.txt', 'Hello!');                  // text/plain
await s3.put('img/logo.png', pngBuffer);                    // image/png
await s3.putJSON('settings.json', { theme: 'dark' });
await s3.putFile('backups/db.sql.gz', './db.sql.gz');       // streamed, multipart

// Read (null when the object doesn't exist)
const text = await s3.getText('notes/hello.txt');
const settings = await s3.getJSON('settings.json');
const buffer = await s3.get('img/logo.png');
await s3.getFile('backups/db.sql.gz', './restore/db.sql.gz');

// Inspect, list, organize
const info = await s3.stat('img/logo.png');                 // { size, contentType, lastModified, etag, metadata }
for await (const { key, size } of s3.list('img/')) console.log(key, size);
await s3.move('notes/hello.txt', 'archive/hello.txt');
await s3.del('a.txt', 'b.txt');

// Links
const download = await s3.signedUrl('backups/db.sql.gz', { ttl: 600, download: true });
const upload = await s3.signedUploadUrl('avatars/42.jpg', { ttl: 300 });

s3.disconnect();
```

Run the full example: `S3_URL="s3://KEY:SECRET@bucket?endpoint=http://localhost:9000" node example.js`

## Connecting

### `connectS3(config?, options?)`

Resolves once the bucket answers. A wrong bucket name or bad credentials fail here, with a clear message.

| `config` | Example |
|--------|---------|
| URL | `s3://KEY:SECRET@bucket?region=eu-west-1&endpoint=https://…` |
| URL, credentials from the AWS chain | `s3://bucket` (env vars, `~/.aws`, IAM role) |
| Object | `{ bucket, region, endpoint, accessKeyId, secretAccessKey, ...anyS3ClientOption }` |
| Nothing | `S3_URL`, or `S3_BUCKET` + `S3_ENDPOINT` + the standard AWS env vars |

> URL-encode the secret if it contains `/` or `+`: `encodeURIComponent(secret)`.

| Option | Default | Description |
|--------|---------|-------------|
| `prefix` | `''` | Prefix every key with `prefix/` |
| `createBucket` | `false` | Create the bucket if it doesn't exist (handy for MinIO and local dev) |
| `publicUrl` | — | Base URL for `url()`, e.g. your CDN or `https://pub-xxx.r2.dev` |
| `service` | `'s3-one'` | Logger service name |
| `logLevel` | `'info'` | `'debug'`, `'info'`, `'warn'`, `'error'` |

Path-style addressing is turned on automatically when you pass an `endpoint`.

### Providers

```js
// AWS S3
connectS3('s3://AKIA…:SECRET@my-bucket?region=eu-central-1');

// Cloudflare R2
connectS3('s3://KEY:SECRET@my-bucket?region=auto&endpoint=https://<ACCOUNT_ID>.r2.cloudflarestorage.com');

// MinIO / SeaweedFS (local)
connectS3('s3://minioadmin:minioadmin@dev?endpoint=http://localhost:9000', { createBucket: true });

// Backblaze B2
connectS3('s3://KEY_ID:APP_KEY@my-bucket?region=us-west-004&endpoint=https://s3.us-west-004.backblazeb2.com');

// DigitalOcean Spaces
connectS3('s3://KEY:SECRET@my-space?region=nyc3&endpoint=https://nyc3.digitaloceanspaces.com');
```

## API

### Write

| Method | Description |
|--------|-------------|
| `put(key, body, options?)` | `body`: string, Buffer, Uint8Array, Blob, or a Node/web stream. Streams go multipart. Returns `{ key, etag }` |
| `putJSON(key, value, options?)` | `JSON.stringify` + `application/json` |
| `putFile(key, filePath, options?)` | Streams a local file. Content type from the file name |

`options`: `contentType` (detected from the key's extension when omitted), `metadata` (`{ [name]: string }`), `cacheControl`, `contentDisposition`.

### Read

| Method | Returns |
|--------|---------|
| `get(key)` | `Buffer` \| `null` |
| `getText(key)` | `string` \| `null` |
| `getJSON(key)` | parsed value \| `null` |
| `getStream(key)` | `Readable` \| `null` — for big objects or piping into an HTTP response |
| `getFile(key, filePath)` | `true` \| `false` (missing). Creates parent folders |
| `stat(key)` | `{ key, size, contentType, lastModified, etag, metadata }` \| `null` |
| `has(key)` | `boolean` |

### List, Delete, Copy

| Method | Description |
|--------|-------------|
| `list(prefix?, { pageSize? })` | Async iterator of `{ key, size, lastModified, etag }` over every page |
| `keys(prefix?)` | All keys as an array |
| `del(...keys)` | Deletes keys (strings or arrays), batched 1,000 per request. Missing keys are fine |
| `copy(from, to)` | Server-side copy |
| `move(from, to)` | Copy, then delete |
| `clear()` | Deletes everything in a namespace. Refuses on the root so you can't empty the bucket by accident |

### Links

```js
// Temporary download link (default ttl: 900 seconds)
await s3.signedUrl('reports/q3.pdf', { ttl: 600 });
await s3.signedUrl('reports/q3.pdf', { download: true });           // browser saves it as q3.pdf
await s3.signedUrl('reports/q3.pdf', { download: 'Q3 Report.pdf' }); // custom file name

// Let a browser upload straight to the bucket - your server never touches the bytes
const url = await s3.signedUploadUrl('avatars/42.jpg', { ttl: 300 }); // contentType from extension
// browser: await fetch(url, { method: 'PUT', body: file, headers: { 'Content-Type': 'image/jpeg' } });

// Public URL for public buckets / CDNs
const cdn = await connectS3(process.env.S3_URL, { publicUrl: 'https://cdn.example.com' });
cdn.url('img/logo.png'); // https://cdn.example.com/img/logo.png
```

The `Content-Type` is part of an upload link's signature: an upload that sends a different type is rejected with `403`. This stops a link meant for `.jpg` from being used to upload HTML.

### `namespace(name)`

A scoped instance that shares the same client. Namespaces nest.

```js
const avatars = s3.namespace('users').namespace('avatars');
await avatars.put('42.png', png);   // key: users/avatars/42.png
await avatars.keys();               // ['42.png']
await avatars.clear();              // deletes only users/avatars/*
```

### Everything Else

| Member | Description |
|--------|-------------|
| `client` | The raw AWS SDK `S3Client` |
| `bucket` / `prefix` | The current bucket and key prefix |
| `disconnect()` | Closes the HTTP connections |
| `sdk` (export) | Every `@aws-sdk/client-s3` export |

```js
import { connectS3, sdk } from 's3-one';

await s3.client.send(new sdk.PutBucketCorsCommand({ Bucket: s3.bucket, CORSConfiguration: { … } }));
```

## Why s3-one? 🤔

The AWS SDK v3 is powerful but verbose: a download means a `GetObjectCommand`, a `Bucket` parameter on every call, converting a stream body by hand, and catching `NoSuchKey` errors. Signed upload URLs from the SDK also fail out of the box, because it signs a checksum of an empty body (s3-one handles that). `s3-one` covers the everyday 90% in one line each, and `s3.client` is still the real SDK for the rest.

## Testing

The suite runs against a real S3 server.

```bash
# Use any S3-compatible server you already run
S3_TEST_ENDPOINT=http://localhost:9000 S3_TEST_ACCESS_KEY=minioadmin S3_TEST_SECRET=minioadmin npm test

# Or let the tests start a throwaway SeaweedFS (download `weed` from github.com/seaweedfs/seaweedfs/releases)
WEED_BIN=./weed npm test
```

## License

MIT © Niv Kaufman
