import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";

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
