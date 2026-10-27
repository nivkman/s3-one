import { S3Client, HeadBucketCommand, CreateBucketCommand } from '@aws-sdk/client-s3';
import { S3One, DeleteError } from './s3-one.js';
import { resolveConfig } from './config.js';

const SILENT = { debug() {}, info() {}, warn() {}, error() {} };

// Silent unless you pass one: a library should not write to your stdout. Any console-like object works.
function createLogger(options) {
  return { ...SILENT, ...pick(options.logger) };
}

function pick(logger) {
  if (!logger) return {};
  return Object.fromEntries(['debug', 'info', 'warn', 'error']
    .filter((level) => typeof logger[level] === 'function')
    .map((level) => [level, (message) => logger[level](`[s3-one] ${message}`)]));
}

function bucketMissing(error) {
  return error?.name === 'NotFound' || error?.name === 'NoSuchBucket' || error?.$metadata?.httpStatusCode === 404;
}

// AWS outside us-east-1 needs a LocationConstraint; S3-compatible servers don't.
async function createBucket(client, bucket, clientOptions, logger) {
  const { endpoint, region } = clientOptions;
  const needsLocation = !endpoint && region !== 'us-east-1';
  const CreateBucketConfiguration = needsLocation ? { LocationConstraint: region } : undefined;
  await client.send(new CreateBucketCommand({ Bucket: bucket, CreateBucketConfiguration }));
  logger.info(`Created bucket ${bucket}`);
}

// HeadBucket on startup so a wrong bucket or bad credentials fail fast, not on the first upload.
async function checkBucket(client, bucket, clientOptions, options, logger) {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (error) {
    if (bucketMissing(error) && options.createBucket) return createBucket(client, bucket, clientOptions, logger);
    const reason = bucketMissing(error) ? 'bucket not found' : describe(error);
    throw new Error(`s3-one: cannot access bucket "${bucket}" (${reason})`, { cause: error });
  }
}

function describe(error) {
  if (error.code) return `${error.code}: ${error.message}`;
  if (error.name && error.name !== 'Error') return error.name;
  return error.message;
}

function joinPrefix(...parts) {
  const clean = parts.map((part) => (part ?? '').replace(/^\/+|\/+$/g, '')).filter(Boolean);
  return clean.length ? `${clean.join('/')}/` : '';
}

export async function connectS3(config, options = {}) {
  const logger = createLogger(options);
  const { bucket, clientOptions, prefix } = resolveConfig(config);
  const client = new S3Client(clientOptions);
  await checkBucket(client, bucket, clientOptions, options, logger).catch((error) => { client.destroy(); throw error; });
  logger.info(`Connected to S3 bucket ${bucket}`);
  const core = { client, clientOptions, logger, bucket, publicUrl: options.publicUrl };
  return new S3One(core, joinPrefix(prefix, options.prefix));
}

export { S3One, S3Client, DeleteError };
export * as sdk from '@aws-sdk/client-s3';
