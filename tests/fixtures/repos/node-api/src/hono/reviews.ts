import { Hono } from 'hono';

type Env = { Variables: { readerId: string } };

export const reviews = new Hono<Env>();

reviews.get('/', (c) => c.json([]));
reviews.post('/:bookId', addReview);
reviews.delete('/:bookId/:reviewId', (c) => c.body(null, 204));

function addReview(c) {
  return c.json({}, 201);
}
