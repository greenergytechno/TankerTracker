import { Injectable } from '@nestjs/common';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  ServerSideEncryption,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { extname } from 'node:path';
import { loadEnv } from '../config/env';

/**
 * Bill scans and stop photos live in object storage, never in Postgres and
 * never served through the API process. Access is by short-lived presigned URL.
 */
@Injectable()
export class StorageService {
  private readonly env = loadEnv();

  private readonly client = new S3Client({
    endpoint: this.env.S3_ENDPOINT,
    region: this.env.S3_REGION,
    forcePathStyle: this.env.S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: this.env.S3_ACCESS_KEY_ID,
      secretAccessKey: this.env.S3_SECRET_ACCESS_KEY,
    },
  });

  /**
   * Content-addressed key. The original filename is kept only as a suffix for
   * human recognition — it never determines the storage path, so a crafted
   * upload name cannot traverse or overwrite anything.
   */
  buildBillKey(checksum: string, originalName: string): string {
    const now = new Date();
    const ext = extname(originalName).toLowerCase().slice(0, 8).replace(/[^.a-z0-9]/g, '');
    return `bills/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${checksum}${ext}`;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.env.S3_BUCKET,
        Key: key,
        Body: body,
        ContentType: contentType,
        ServerSideEncryption: ServerSideEncryption.AES256,
      }),
    );
  }

  presignedGetUrl(key: string, expiresInSeconds = 300): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.env.S3_BUCKET, Key: key }),
      { expiresIn: expiresInSeconds },
    );
  }
}
