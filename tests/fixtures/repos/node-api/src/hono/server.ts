import { Hono } from 'hono';
import { reviews } from './reviews';

type Env = { Variables: { readerId: string } };

const server = new Hono<Env>();

server.route('/reviews', reviews);

export default server;
