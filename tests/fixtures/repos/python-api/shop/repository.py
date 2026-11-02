"""Data access through SQLAlchemy sessions (fictional test fixture)."""
from sqlalchemy import delete, insert, select, update

from app.models import Author, Book


def list_books(session):
    return session.query(Book).all()


def books_of(session, author_id):
    return session.execute(select(Book).where(Book.author_id == author_id)).scalars().all()


def add_author(session, name):
    session.add(Author(name=name))
    session.commit()


def rename_author(session, author_id, name):
    session.execute(update(Author).where(Author.id == author_id).values(name=name))


def drop_old_books(session):
    session.query(Book).filter(Book.title == "").delete()


def remove_author(session, author: Author):
    session.delete(author)


def seed_book(session, title):
    session.execute(insert(Book).values(title=title))


def purge_authors(session):
    session.execute(delete(Author))


def anything(session, model):
    return session.query(model).all()
