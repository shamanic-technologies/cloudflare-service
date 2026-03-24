import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";

const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || "";
const R2_PUBLIC_DOMAIN = process.env.R2_PUBLIC_DOMAIN || "";
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || "";

function createS3Client(accessKeyId: string, secretAccessKey: string): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
}

export async function uploadToR2(
  accessKeyId: string,
  secretAccessKey: string,
  key: string,
  body: Buffer,
  contentType?: string
): Promise<string> {
  const s3 = createS3Client(accessKeyId, secretAccessKey);

  await s3.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );

  return `https://${R2_PUBLIC_DOMAIN}/${key}`;
}

export async function deleteFromR2(
  accessKeyId: string,
  secretAccessKey: string,
  key: string
): Promise<void> {
  const s3 = createS3Client(accessKeyId, secretAccessKey);

  await s3.send(
    new DeleteObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
    })
  );
}

export function buildPublicUrl(key: string): string {
  return `https://${R2_PUBLIC_DOMAIN}/${key}`;
}
