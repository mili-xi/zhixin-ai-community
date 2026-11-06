import pytest

from app.auth.context import ActorContext, ActorRole
from app.auth.security import generate_numeric_code, generate_secret, hash_secret, verify_secret


def test_actor_context_is_explicit_and_immutable():
    actor = ActorContext(user_id="user-a", role=ActorRole.MEMBER, device_id=None)

    assert actor.owner_id == "user-a"
    with pytest.raises(Exception):
        actor.user_id = "user-b"


def test_secret_hash_is_one_way_and_verifiable():
    secret = generate_secret()
    digest = hash_secret(secret)

    assert secret not in digest
    assert verify_secret(secret, digest) is True
    assert verify_secret("wrong", digest) is False


def test_numeric_login_code_has_six_digits():
    code = generate_numeric_code()

    assert len(code) == 6
    assert code.isdigit()


def test_actor_context_rejects_blank_user_id():
    with pytest.raises(ValueError, match="ACTOR_USER_ID_REQUIRED"):
        ActorContext(user_id="", role=ActorRole.MEMBER)
