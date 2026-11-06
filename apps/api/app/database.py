from collections.abc import Generator

from sqlalchemy import JSON, DateTime, String, create_engine, func, inspect, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Mapped, Session, mapped_column, sessionmaker

from .config import get_settings
from .models.base import Base

ALEMBIC_HEAD_REVISION = "0005_password_registration"


class Record(Base):
    __tablename__ = "records"

    id: Mapped[str] = mapped_column(String(120), primary_key=True)
    kind: Mapped[str] = mapped_column(String(80), index=True, nullable=False)
    owner_id: Mapped[str] = mapped_column(String(120), index=True, nullable=False, default="legacy-internal-owner")
    data: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[object] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[object] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)


# Import relational models after Record so every table shares this metadata.
from .models import auth as _auth_models  # noqa: E402,F401
from .models import workflows as _workflow_models  # noqa: E402,F401


def _connect_args(database_url: str) -> dict:
    if database_url.startswith("sqlite"):
        return {"check_same_thread": False}
    return {}


def assert_database_migrated(target_engine: Engine) -> None:
    with target_engine.connect() as connection:
        tables = set(inspect(connection).get_table_names())
        if "alembic_version" not in tables:
            raise RuntimeError("DATABASE_MIGRATION_REQUIRED: run 'alembic upgrade head'")
        revisions = set(connection.execute(text("SELECT version_num FROM alembic_version")).scalars())
    if revisions != {ALEMBIC_HEAD_REVISION}:
        current = ",".join(sorted(revisions)) or "none"
        raise RuntimeError(
            f"DATABASE_MIGRATION_OUTDATED: current={current}, expected={ALEMBIC_HEAD_REVISION}; "
            "run 'alembic upgrade head'"
        )


settings = get_settings()
engine = create_engine(settings.database_url, connect_args=_connect_args(settings.database_url), future=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)


def init_db() -> None:
    if engine.dialect.name == "sqlite":
        Base.metadata.create_all(bind=engine)
        return
    assert_database_migrated(engine)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()