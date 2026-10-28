import { emailQueue } from './email.queue';

export async function sendWelcome(to: string) {
  await emailQueue.add('welcome', { to });
}

export async function sendReceipt(to: string, orderId: number) {
  await emailQueue.add('receipt', { to, orderId }, { attempts: 3 });
}

export async function sendNamed(kind: string, to: string) {
  await emailQueue.add(kind, { to });
}
