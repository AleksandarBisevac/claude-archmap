import { Queue } from 'bullmq';

export const EMAIL_QUEUE = 'email';
export const connection = { host: 'localhost', port: 6379 };

export const emailQueue = new Queue(EMAIL_QUEUE, { connection });
