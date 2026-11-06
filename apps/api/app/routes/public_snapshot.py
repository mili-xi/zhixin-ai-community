from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..csdn_public_snapshot import (
    CsdnPublicSnapshotError,
    fetch_csdn_public_snapshot,
    validate_csdn_public_url,
)


router = APIRouter(prefix="/api/public-snapshots", tags=["public-snapshots"])


class CsdnPublicSnapshotRequest(BaseModel):
    url: str = Field(min_length=1, max_length=500)


@router.post("/csdn")
def create_csdn_public_snapshot(payload: CsdnPublicSnapshotRequest) -> dict:
    try:
        validate_csdn_public_url(payload.url)
        return fetch_csdn_public_snapshot(payload.url)
    except CsdnPublicSnapshotError as error:
        detail = str(error) or "CSDN_PUBLIC_FETCH_FAILED"
        status_code = 400 if detail == "CSDN_PUBLIC_URL_INVALID" else 502
        raise HTTPException(status_code=status_code, detail=detail) from error
