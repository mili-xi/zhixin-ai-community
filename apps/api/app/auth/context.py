from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar, Token
from dataclasses import dataclass
from typing import Iterator
from enum import StrEnum


_current_actor: ContextVar[ActorContext | None] = ContextVar("zhixin_current_actor", default=None)


class ActorRole(StrEnum):
    MEMBER = "member"
    SYSTEM_WORKER = "system_worker"


@dataclass(frozen=True, slots=True)
class ActorContext:
    user_id: str
    role: ActorRole
    device_id: str | None = None

    def __post_init__(self) -> None:
        normalized_user_id = self.user_id.strip()
        if not normalized_user_id:
            raise ValueError("ACTOR_USER_ID_REQUIRED")
        object.__setattr__(self, "user_id", normalized_user_id)
        if self.device_id is not None:
            normalized_device_id = self.device_id.strip()
            object.__setattr__(self, "device_id", normalized_device_id or None)

    @property
    def owner_id(self) -> str:
        return self.user_id

    @classmethod
    def system_worker(cls, owner_id: str) -> "ActorContext":
        return cls(user_id=owner_id, role=ActorRole.SYSTEM_WORKER)


def current_actor() -> ActorContext | None:
    return _current_actor.get()


@contextmanager
def actor_scope(actor: ActorContext | None) -> Iterator[None]:
    token: Token[ActorContext | None] = _current_actor.set(actor)
    try:
        yield
    finally:
        _current_actor.reset(token)


def current_owner_id() -> str | None:
    actor = current_actor()
    return actor.owner_id if actor is not None else None
