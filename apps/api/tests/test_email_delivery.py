from __future__ import annotations

from email.message import EmailMessage

import pytest

from app.auth.email_delivery import EmailDeliveryError, deliver_registration_code
from app.auth.service import IssuedRegistrationCode
from app.config import Settings


class FakeSmtp:
    def __init__(self, host: str, port: int, timeout: float):
        self.host = host
        self.port = port
        self.timeout = timeout
        self.started_tls = False
        self.login_args: tuple[str, str] | None = None
        self.message: EmailMessage | None = None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def starttls(self):
        self.started_tls = True

    def login(self, username: str, password: str):
        self.login_args = (username, password)

    def send_message(self, message: EmailMessage):
        self.message = message


def test_smtp_delivery_sends_registration_code_with_tls() -> None:
    smtp_instances: list[FakeSmtp] = []

    def smtp_factory(host: str, port: int, timeout: float):
        instance = FakeSmtp(host, port, timeout)
        smtp_instances.append(instance)
        return instance

    settings = Settings(
        _env_file=None,
        auth_email_delivery="smtp",
        auth_smtp_host="smtp.example.com",
        auth_smtp_port=587,
        auth_smtp_username="mailer",
        auth_smtp_password="secret",
        auth_smtp_from_email="register@example.com",
        auth_smtp_from_name="Zhixin AI",
        auth_smtp_starttls=True,
    )
    issued = IssuedRegistrationCode(email="member@example.com", code="123456", expires_in=600)

    deliver_registration_code(settings, issued, smtp_factory=smtp_factory)

    smtp = smtp_instances[0]
    assert (smtp.host, smtp.port, smtp.timeout) == ("smtp.example.com", 587, 15.0)
    assert smtp.started_tls is True
    assert smtp.login_args == ("mailer", "secret")
    assert smtp.message is not None
    assert smtp.message["To"] == "member@example.com"
    assert smtp.message["From"] == "Zhixin AI <register@example.com>"
    assert "123456" in smtp.message.get_content()
    assert "10" in smtp.message.get_content()


def test_smtp_delivery_rejects_missing_required_configuration() -> None:
    settings = Settings(_env_file=None, auth_email_delivery="smtp", auth_smtp_host="")
    issued = IssuedRegistrationCode(email="member@example.com", code="123456", expires_in=600)

    with pytest.raises(EmailDeliveryError, match="AUTH_EMAIL_DELIVERY_NOT_CONFIGURED"):
        deliver_registration_code(settings, issued)


def test_unknown_delivery_mode_is_rejected() -> None:
    settings = Settings(_env_file=None, auth_email_delivery="unsupported")
    issued = IssuedRegistrationCode(email="member@example.com", code="123456", expires_in=600)

    with pytest.raises(EmailDeliveryError, match="AUTH_EMAIL_DELIVERY_UNSUPPORTED"):
        deliver_registration_code(settings, issued)