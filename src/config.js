// Turns a URL, an options object or the environment into S3Client options + a bucket.
//   s3://ACCESS_KEY:SECRET@bucket?region=auto&endpoint=https://<account>.r2.cloudflarestorage.com
//   s3://bucket                       (credentials from the standard AWS chain)

function credentialsFrom(accessKeyId, secretAccessKey) {
  if (!accessKeyId) return undefined;
  return { accessKeyId, secretAccessKey };
}

function fromUrl(text) {
  const url = new URL(text);
  if (url.protocol !== 's3:') throw new Error(`s3-one: expected an s3:// URL, got "${url.protocol}//"`);
  return {
    bucket: decodeURIComponent(url.hostname || url.pathname.replace(/^\/+/, '')),
    region: url.searchParams.get('region') ?? undefined,
    endpoint: url.searchParams.get('endpoint') ?? undefined,
    accessKeyId: decodeURIComponent(url.username) || undefined,
    secretAccessKey: decodeURIComponent(url.password) || undefined,
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
  const { bucket, region, endpoint, accessKeyId, secretAccessKey, forcePathStyle, ...rest } = normalize(config);
  if (!bucket) throw new Error('s3-one: no bucket - pass s3://key:secret@bucket or { bucket } or set S3_URL / S3_BUCKET');
  const clientOptions = {
    ...rest,
    region: region ?? process.env.AWS_REGION ?? 'us-east-1',
    endpoint,
    forcePathStyle: forcePathStyle ?? Boolean(endpoint),
    credentials: rest.credentials ?? credentialsFrom(accessKeyId, secretAccessKey),
  };
  return { bucket, clientOptions };
}
