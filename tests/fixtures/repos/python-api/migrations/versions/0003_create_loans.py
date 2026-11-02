"""loans: a table only this migration declares"""
import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"


def upgrade():
    op.create_table(
        "loans",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("book_id", sa.Integer(), sa.ForeignKey("books.id")),
        sa.Column("due_on", sa.Date()),
    )


def downgrade():
    op.drop_table("loans")
