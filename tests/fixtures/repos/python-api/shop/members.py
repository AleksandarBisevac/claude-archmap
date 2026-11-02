"""Library members, declared with SQLModel (fictional test fixture)."""
from typing import Optional

from sqlmodel import Field, Relationship, SQLModel


class MemberBase(SQLModel):
    name: str
    email: str


class Member(MemberBase, table=True):
    __tablename__ = "members"

    id: Optional[int] = Field(default=None, primary_key=True)
    branch_id: int = Field(foreign_key="branches.id")
    branch: "Branch" = Relationship(back_populates="members")


class MemberCreate(MemberBase):
    branch_id: int
