import { redis } from '../config';
import { sendWelcome } from '../queues/email.producer';

export async function register(to: string) {
  await redis.incr('registrations');
  await sendWelcome(to);
}
