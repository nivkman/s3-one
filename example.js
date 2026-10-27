// Run: S3_URL="s3://KEY:SECRET@my-bucket?endpoint=http://localhost:8333" node example.js
import { connectS3 } from './src/index.js';

const s3 = await connectS3(process.env.S3_URL, { prefix: 'example', createBucket: true, logger: console });

// Text, JSON and binary
await s3.put('hello.txt', 'Hello from s3-one 👋');
await s3.putJSON('config.json', { theme: 'dark', version: 2 });
console.log(await s3.getText('hello.txt'));
console.log(await s3.getJSON('config.json'));

// Metadata - content type was detected from the extension
console.log(await s3.stat('hello.txt'));

// Temporary links
console.log('download:', await s3.signedUrl('hello.txt', { ttl: 60 }));
console.log('upload:  ', await s3.signedUploadUrl('avatars/1.png', { ttl: 300 }));

// List everything under the prefix
for await (const { key, size } of s3.list()) console.log(`- ${key} (${size} bytes)`);

console.log('missing file:', await s3.get('nope.txt')); // null, not an exception

await s3.clear();
s3.disconnect();
