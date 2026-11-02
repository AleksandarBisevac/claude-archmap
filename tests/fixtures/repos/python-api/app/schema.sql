-- Fines the front desk charges; the database file is made at deploy time and is not in the repository.
CREATE TABLE IF NOT EXISTS fines (
  id INTEGER PRIMARY KEY,
  member_id INTEGER REFERENCES members (id),
  amount_cents INTEGER NOT NULL
);
