import { S3Client, HeadBucketCommand, CreateBucketCommand } from '@aws-sdk/client-s3';
import { Logger } from 'logger-standard';
import { S3One, isNotFound } from './s3-one.js';
import { resolveConfig } from './config.js';

function createLogger(options) {
  const service = options.service || 's3-one';
  const logLevel = options.logLevel || 'info';
  return new Logger({ service, logLevel });
}

async function createBucket(client, bucket, logger) {
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  logger.info(`Created bucket ${bucket}`);
}

// HeadBucket on startup so a wrong bucket or bad credentials fail fast, not on the first upload.
async function checkBucket(client, bucket, options, logger) {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (error) {
    if (isNotFound(error) && options.createBucket) return createBucket(client, bucket, logger);
    const reason = isNotFound(error) ? 'bucket not found' : error.name || error.message;
    throw new Error(`s3-one: cannot access bucket "${bucket}" (${reason})`, { cause: error });
  }
}

export async function connectS3(config, options = {}) {
  const logger = createLogger(options);
  const { bucket, clientOptions } = resolveConfig(config);
  const client = new S3Client(clientOptions);
  await checkBucket(client, bucket, options, logger).catch((error) => { client.destroy(); throw error; });
  logger.info(`Connected to S3 bucket ${bucket}`);
  const core = { client, clientOptions, logger, bucket, publicUrl: options.publicUrl };
  return new S3One(core, options.prefix ? `${options.prefix.replace(/\/+$/, '')}/` : '');
}

export { S3One, S3Client };
export * as sdk from '@aws-sdk/client-s3';
