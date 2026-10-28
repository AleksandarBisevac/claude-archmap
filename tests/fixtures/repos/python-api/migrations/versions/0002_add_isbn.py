"""add isbn to books"""
from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: Union[str, None] = "0001"


def upgrade():
    op.add_column("books", sa.Column("isbn", sa.String(13)))
    op.alter_column("books", "title", nullable=False)
    op.execute("UPDATE books SET isbn = '' WHERE isbn IS NULL")
    op.bulk_insert(sa.table("books"), [])


def downgrade():
    op.drop_column("books", "isbn")
