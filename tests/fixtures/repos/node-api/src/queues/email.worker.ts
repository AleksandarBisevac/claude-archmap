import { Worker } from 'bullmq';
import { connection, EMAIL_QUEUE } from './email.queue';

async function deliver(job) {
  return job.data.to;
}

export const emailWorker = new Worker(EMAIL_QUEUE, deliver, { connection, concurrency: 5 });
