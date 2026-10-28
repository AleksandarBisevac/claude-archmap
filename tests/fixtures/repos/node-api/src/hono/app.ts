import { Hono } from 'hono';

const app = new Hono();
const authors = new Hono();

authors.get('/', (c) => c.json([]));
authors.get('/:id', (c) => c.json({ id: c.req.param('id') }));
authors.post('/', createAuthor);

app.route('/authors', authors);
app.get('/health', (c) => c.text('ok'));
app.all('/ping', (c) => c.text('pong'));
app.on(['GET', 'POST'], '/search', (c) => c.json([]));
app.get(`/legacy/${process.env.LEGACY_SLUG}`, (c) => c.text('old'));

function createAuthor(c) {
  return c.json({}, 201);
}

export default app;
