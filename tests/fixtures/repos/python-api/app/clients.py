"""Outbound HTTP calls (fictional test fixture)."""
import urllib.request

import httpx
import requests

ISBN_URL = "https://isbn.example.invalid/v1"


def lookup_isbn(isbn):
    return requests.get("https://isbn.example.invalid/v1/books", params={"isbn": isbn}, timeout=5)


async def notify_courier(order_id):
    async with httpx.AsyncClient() as client:
        await client.post("https://courier.example.invalid/api/pickups", json={"order": order_id})


def refresh_rates():
    session = requests.Session()
    session.put(ISBN_URL + "/rates")
    requests.request("DELETE", "https://isbn.example.invalid/v1/cache")
    urllib.request.urlopen("https://status.example.invalid/ping")
