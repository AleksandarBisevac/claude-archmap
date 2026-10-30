# Fictional worker for the merge fixture: read as text, never run.
from api.models import Order
from shared.fmt import money

def _subject(order):
    return "Receipt " + money(order.total)

def send_receipt(order_id):
    # The consumer of the send_receipt queue.
    order = None
    # Reads the order back before mailing it.
    rows = "select id, total from orders where id = ?"
    return _subject(order) if order else rows
