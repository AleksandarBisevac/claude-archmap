import { S3Client } from '@aws-sdk/client-s3';
import Redis from 'ioredis';

export const databaseUrl = process.env.DATABASE_URL;
export const { QUEUE_PREFIX = 'q' } = process.env;

export const redis = new Redis(process.env['REDIS_URL']);
export const covers = new S3Client({ endpoint: process.env.OBJECT_STORE_URL });
