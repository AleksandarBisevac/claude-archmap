"""Task producers (fictional test fixture)."""
from app.tasks import rebuild_index, send_receipt
from shop.models import Edition


def on_order(order_id):
    send_receipt.delay(order_id)
    return Edition


def nightly():
    rebuild_index.apply_async(queue="maintenance")
