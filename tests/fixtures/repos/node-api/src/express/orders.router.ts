import { Router } from 'express';

export const ordersRouter = Router();

const ORDER_PATH = '/by-' + 'ref';

ordersRouter.get('/', listOrders);
ordersRouter.get('/:orderId', getOrder);
ordersRouter.post('/', (req, res) => {
  res.status(201).json(req.body);
});
ordersRouter.delete('/:orderId', cancelOrder);
ordersRouter.get(ORDER_PATH, findByRef);
ordersRouter.route('/:orderId/items').get(listItems);

function listOrders(req, res) {
  res.json([]);
}
function getOrder(req, res) {
  res.json({});
}
function cancelOrder(req, res) {
  res.sendStatus(204);
}
function findByRef(req, res) {
  res.json({});
}
function listItems(req, res) {
  res.json([]);
}
