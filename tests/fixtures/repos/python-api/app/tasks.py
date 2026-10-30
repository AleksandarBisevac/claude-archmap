"""Background tasks (fictional test fixture)."""
import os

from celery import Celery, shared_task

celery_app = Celery("shop", broker=os.environ["BROKER_URL"])


@celery_app.task(queue="emails")
def send_receipt(order_id):
    return order_id


@shared_task
def rebuild_index():
    return None
