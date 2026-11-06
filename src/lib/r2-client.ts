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

/**
 * Socket timeouts on every R2 call (BACKUP-HANG-1106). The SDK default is NO
 * timeout: a part upload whose socket goes silent waits forever, stops reading
 * the pg_dump pipe, and the dump's transaction then holds its read locks for
 * days (lead_service, 2026-11-03 → 11-06). `requestTimeout` is the socket
 * INACTIVITY limit (not a total), so a slow-but-moving 8 MB part is never cut;
 * a timed-out request is retried by the SDK's standard retry strategy.
 */
export const R2_CONNECTION_TIMEOUT_MS = 30_000;
export const R2_REQUEST_TIMEOUT_MS = 5 * 60_000;

function createS3Client(config: R2Config): S3Client {
  return new S3Client({
    region: "auto",
    requestHandler: {
      connectionTimeout: R2_CONNECTION_TIMEOUT_MS,
      requestTimeout: R2_REQUEST_TIMEOUT_MS,
    },
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
  options?: { partSizeBytes?: number; queueSize?: number; signal?: AbortSignal }
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

  // A caller that gave up (stalled dump, spent budget) aborts the multipart
  // upload, so the promise settles and no orphan parts are left on R2.
  const signal = options?.signal;
  const onAbort = () => void upload.abort().catch(() => undefined);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });

  try {
    await upload.done();
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }

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
