"""Select the top sellers from the catalogue (a docstring, not SQL)."""
from sqlalchemy import text


def top_authors(conn):
    return conn.execute(text("""
        SELECT a.name, COUNT(*) FROM authors a
        JOIN books b ON b.author_id = a.id
        GROUP BY a.name
    """))


def archive_orders(cur, cutoff, table_name):
    cur.execute("DELETE FROM orders WHERE placed_at < %s", (cutoff,))
    cur.execute("insert into order_archive (id) select id from orders")
    cur.execute("UPDATE stock SET qty = qty - 1")
    cur.execute(f"SELECT * FROM {table_name}")
