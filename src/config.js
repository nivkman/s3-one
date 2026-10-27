// Turns a URL, an options object or the environment into S3Client options + a bucket.
//   s3://ACCESS_KEY:SECRET@bucket?region=auto&endpoint=https://<account>.r2.cloudflarestorage.com
//   s3://bucket                       (credentials from the standard AWS chain)
//   s3://KEY:SECRET@bucket/some/prefix (every key goes under some/prefix/)

function credentialsFrom(accessKeyId, secretAccessKey) {
  if (!accessKeyId) return undefined;
  return { accessKeyId, secretAccessKey };
}

function decode(part, name) {
  try {
    return decodeURIComponent(part) || undefined;
  } catch {
    throw new Error(`s3-one: the ${name} in the S3 URL has a "%" that isn't URL-encoded - wrap it in encodeURIComponent()`);
  }
}

function fromUrl(text) {
  const url = new URL(text);
  if (url.protocol !== 's3:') throw new Error(`s3-one: expected an s3:// URL, got "${url.protocol}//"`);
  return {
    bucket: decode(url.hostname, 'bucket'),
    prefix: decode(url.pathname.replace(/^\/+/, ''), 'path'),
    region: url.searchParams.get('region') || undefined,
    endpoint: url.searchParams.get('endpoint') || undefined,
    accessKeyId: decode(url.username, 'access key'),
    secretAccessKey: decode(url.password, 'secret'),
  };
}

function fromEnv() {
  return { bucket: process.env.S3_BUCKET, endpoint: process.env.S3_ENDPOINT };
}

function normalize(config) {
  if (typeof config === 'string') return fromUrl(config);
  return config ?? (process.env.S3_URL ? fromUrl(process.env.S3_URL) : fromEnv());
}

export function resolveConfig(config) {
  const { bucket, prefix, region, endpoint, accessKeyId, secretAccessKey, forcePathStyle, ...rest } = normalize(config);
  if (!bucket) throw new Error('s3-one: no bucket - pass s3://key:secret@bucket or { bucket } or set S3_URL / S3_BUCKET');
  const clientOptions = {
    ...rest,
    region: region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
    // A bucket in another region than the client answers 301; follow it instead of failing.
    followRegionRedirects: rest.followRegionRedirects ?? true,
    endpoint,
    forcePathStyle: forcePathStyle ?? Boolean(endpoint),
    credentials: rest.credentials ?? credentialsFrom(accessKeyId, secretAccessKey),
  };
  return { bucket, clientOptions, prefix };
}
