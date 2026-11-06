from __future__ import annotations

import hashlib
import hmac
import secrets

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError


_password_hasher = PasswordHasher(time_cost=3, memory_cost=65536, parallelism=4, hash_len=32, salt_len=16)


def generate_secret(bytes_count: int = 32) -> str:
    if bytes_count < 16:
        raise ValueError("SECRET_ENTROPY_TOO_LOW")
    return secrets.token_urlsafe(bytes_count)


def generate_numeric_code(digits: int = 6) -> str:
    if digits < 4:
        raise ValueError("LOGIN_CODE_TOO_SHORT")
    upper_bound = 10**digits
    return f"{secrets.randbelow(upper_bound):0{digits}d}"


def hash_secret(secret: str) -> str:
    if not secret:
        raise ValueError("SECRET_REQUIRED")
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def verify_secret(secret: str, expected_hash: str) -> bool:
    if not secret or not expected_hash:
        return False
    return hmac.compare_digest(hash_secret(secret), expected_hash)


def hash_password(password: str) -> str:
    if not password:
        raise ValueError("PASSWORD_REQUIRED")
    return _password_hasher.hash(password)


def verify_password(password: str, expected_hash: str | None) -> bool:
    if not password or not expected_hash:
        return False
    try:
        return _password_hasher.verify(expected_hash, password)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False