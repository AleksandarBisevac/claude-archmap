"""Back-room bookkeeping over a DB-API connection (fictional fixture; the database file is made at runtime)."""

SCHEMA = """
CREATE TABLE IF NOT EXISTS shelves (
    id INTEGER PRIMARY KEY,
    label TEXT NOT NULL,
    floor INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS shelf_moves (
    id INTEGER PRIMARY KEY,
    shelf_id INTEGER NOT NULL REFERENCES shelves(id),
    copy_ref TEXT,
    moved_at TEXT,
    UNIQUE (copy_ref, moved_at)
);
"""


def setup(conn):
    conn.executescript(SCHEMA)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS courier_slots (slot_id TEXT PRIMARY KEY, day TEXT, taken INTEGER)"
    )


def shelf_report(conn, floor):
    return conn.execute(
        """
        SELECT s.label, COUNT(m.id)
        FROM shelves s
        LEFT JOIN shelf_moves m ON m.shelf_id = s.id
        WHERE s.floor = ?
        GROUP BY s.label
        """,
        (floor,),
    ).fetchall()


def record_move(conn, shelf_id, copy_ref, when):
    conn.execute("INSERT INTO shelf_moves (shelf_id, copy_ref, moved_at) VALUES (?, ?, ?)", (shelf_id, copy_ref, when))
    conn.execute("UPDATE shelves SET floor = floor WHERE id = ?", (shelf_id,))


def take_slot(conn, slot, day):
    conn.execute("UPDATE courier_slots SET taken = 1 " "WHERE slot_id = ? AND day = ?", (slot, day))


def returns_desk(conn, copy_ref):
    open_rows = conn.execute("SELECT copy_ref FROM returns_desk WHERE handled = 0").fetchall()
    conn.execute("INSERT INTO returns_desk (copy_ref) VALUES (?)", (copy_ref,))
    conn.execute("DELETE FROM returns_desk WHERE handled = 1")
    return conn.execute("SELECT * FROM price_checks pc JOIN returns_desk r ON r.id = pc.id").fetchall(), open_rows
