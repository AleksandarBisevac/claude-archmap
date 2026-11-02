const express = require('express');
const { listParcels, findParcel } = require('./db/parcels');

const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/parcels', async (req, res) => {
  res.json(await listParcels());
});

app.get('/parcels/:parcelId', async (req, res) => {
  res.json(await findParcel(req.params.parcelId));
});

app.listen(3000);
