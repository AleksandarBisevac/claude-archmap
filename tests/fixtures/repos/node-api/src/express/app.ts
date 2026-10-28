import express from 'express';
import { ordersRouter } from './orders.router';

const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true }));
app.use('/orders', ordersRouter);

app.listen(4000);
