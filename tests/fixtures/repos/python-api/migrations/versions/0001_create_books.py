"""create authors and books"""
import sqlalchemy as sa
from alembic import op

revision = "0001"
down_revision = None


def upgrade():
    op.create_table(
        "authors",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("name", sa.String(120), nullable=False),
    )
    op.create_table("books", sa.Column("id", sa.Integer, primary_key=True), sa.Column("author_id", sa.Integer, sa.ForeignKey("authors.id")))
    op.create_index("ix_books_author_id", "books", ["author_id"])


def downgrade():
    op.drop_table("books")
    op.drop_table("authors")
