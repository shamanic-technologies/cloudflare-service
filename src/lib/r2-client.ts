import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { Readable } from "stream";

export interface R2Config {
  accessKeyId: string;
  secretAccessKey: string;
  accountId: string;
  bucketName: string;
  publicDomain: string;
}

function createS3Client(config: R2Config): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

export async function uploadToR2(
  config: R2Config,
  key: string,
  body: Buffer,
  contentType?: string
): Promise<string> {
  const s3 = createS3Client(config);

  await s3.send(
    new PutObjectCommand({
      Bucket: config.bucketName,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );

  const domain = config.publicDomain.replace(/^https?:\/\//, "");
  return `https://${domain}/${key}`;
}

/**
 * Stream an object into R2 using multipart upload. Never buffers the whole
 * payload: `partSizeBytes * queueSize` bounds the memory a multi-GB pg_dump can
 * take (default 32 MB).
 */
export async function uploadStreamToR2(
  config: R2Config,
  key: string,
  body: Readable,
  contentType?: string,
  options?: { partSizeBytes?: number; queueSize?: number }
): Promise<string> {
  const s3 = createS3Client(config);

  const upload = new Upload({
    client: s3,
    params: {
      Bucket: config.bucketName,
      Key: key,
      Body: body,
      ContentType: contentType,
    },
    partSize: options?.partSizeBytes ?? 8 * 1024 * 1024,
    queueSize: options?.queueSize ?? 4,
    leavePartsOnError: false,
  });

  await upload.done();

  const domain = config.publicDomain.replace(/^https?:\/\//, "");
  return `https://${domain}/${key}`;
}

export interface R2ListedObject {
  key: string;
  size: number;
  lastModified: Date | null;
}

/** List every object under a prefix, following continuation tokens. */
export async function listR2Objects(
  config: R2Config,
  prefix: string
): Promise<R2ListedObject[]> {
  const s3 = createS3Client(config);
  const objects: R2ListedObject[] = [];
  let continuationToken: string | undefined;

  do {
    const response = await s3.send(
      new ListObjectsV2Command({
        Bucket: config.bucketName,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );

    for (const item of response.Contents ?? []) {
      if (!item.Key) continue;
      objects.push({
        key: item.Key,
        size: item.Size ?? 0,
        lastModified: item.LastModified ?? null,
      });
    }

    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  return objects;
}

export interface R2Object {
  body: Buffer;
  contentType: string;
}

export async function getFromR2(
  config: R2Config,
  key: string
): Promise<R2Object | null> {
  const s3 = createS3Client(config);

  const response = await s3.send(
    new GetObjectCommand({
      Bucket: config.bucketName,
      Key: key,
    })
  ).catch((err: unknown) => {
    if (err instanceof Error && err.name === "NoSuchKey") return null;
    throw err;
  });

  if (!response || !response.Body) return null;

  const bodyBytes = await response.Body.transformToByteArray();
  return {
    body: Buffer.from(bodyBytes),
    contentType: response.ContentType || "application/octet-stream",
  };
}

export async function deleteFromR2(
  config: R2Config,
  key: string
): Promise<void> {
  const s3 = createS3Client(config);

  await s3.send(
    new DeleteObjectCommand({
      Bucket: config.bucketName,
      Key: key,
    })
  );
}
