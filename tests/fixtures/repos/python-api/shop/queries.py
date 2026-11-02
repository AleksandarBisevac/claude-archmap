"""Member lookups with SQLModel sessions (fictional test fixture)."""
from sqlmodel import Session, select

from shop.members import Member


def members_of(session: Session, branch_id: int):
    return session.exec(select(Member).where(Member.branch_id == branch_id)).all()


def join_member(session: Session, name: str, email: str):
    member = Member(name=name, email=email, branch_id=1)
    session.add(member)
    session.commit()


def leave(session: Session, member_id: int):
    member = session.get(Member, member_id)
    session.delete(member)
