"""Request and response schemas (fictional test fixture)."""
from typing import Optional

from pydantic import BaseModel, Field


class BookBase(BaseModel):
    title: str
    isbn: str = Field(min_length=10)
    price_cents: int = 0


class BookIn(BookBase):
    author_id: int


class BookOut(BookBase):
    id: int
    subtitle: Optional[str] = None
