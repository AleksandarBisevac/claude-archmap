"""Bookshop API (fictional test fixture)."""
from fastapi import APIRouter, FastAPI

from app.schemas import BookIn, BookOut

app = FastAPI(title="Bookshop")
router = APIRouter(prefix="/api/v1")

ITEMS_PREFIX = "/items"


@app.get("/health")
def health():
    return {"ok": True}


@router.get("/books", response_model=list[BookOut])
async def list_books():
    return []


@router.post(
    "/books",
    response_model=BookOut,
    status_code=201,
)
async def create_book(body: BookIn):
    return body


@router.get("/books/{book_id}")
def get_book(book_id: int):
    return {"id": book_id}


@router.delete(ITEMS_PREFIX + "/{item_id}")
def delete_item(item_id: int):
    return None
