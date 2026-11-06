from __future__ import annotations

import smtplib
from email.message import EmailMessage
from email.utils import formataddr
from math import ceil
from typing import Callable

from ..config import Settings
from .service import IssuedRegistrationCode


class EmailDeliveryError(RuntimeError):
    pass


SmtpFactory = Callable[..., smtplib.SMTP]


def _registration_message(settings: Settings, issued: IssuedRegistrationCode) -> EmailMessage:
    minutes = max(1, ceil(issued.expires_in / 60))
    message = EmailMessage()
    message["Subject"] = "智心AI 注册验证码"
    message["From"] = formataddr((settings.auth_smtp_from_name, settings.auth_smtp_from_email))
    message["To"] = issued.email
    message.set_content(
        f"你的智心AI注册验证码是：{issued.code}\n\n"
        f"验证码在 {minutes} 分钟内有效，请勿转发给他人。\n"
    )
    return message


def deliver_registration_code(
    settings: Settings,
    issued: IssuedRegistrationCode,
    *,
    smtp_factory: SmtpFactory = smtplib.SMTP,
    smtp_ssl_factory: SmtpFactory = smtplib.SMTP_SSL,
) -> None:
    mode = settings.auth_email_delivery.strip().lower()
    if mode == "console":
        print(f"[zhixin-auth] registration code for {issued.email}: {issued.code}", flush=True)
        return
    if mode != "smtp":
        raise EmailDeliveryError("AUTH_EMAIL_DELIVERY_UNSUPPORTED")
    if not settings.auth_smtp_host or not settings.auth_smtp_from_email:
        raise EmailDeliveryError("AUTH_EMAIL_DELIVERY_NOT_CONFIGURED")

    factory = smtp_ssl_factory if settings.auth_smtp_use_ssl else smtp_factory
    try:
        with factory(
            settings.auth_smtp_host,
            settings.auth_smtp_port,
            timeout=settings.auth_smtp_timeout_seconds,
        ) as smtp:
            if settings.auth_smtp_starttls and not settings.auth_smtp_use_ssl:
                smtp.starttls()
            if settings.auth_smtp_username:
                smtp.login(settings.auth_smtp_username, settings.auth_smtp_password)
            smtp.send_message(_registration_message(settings, issued))
    except EmailDeliveryError:
        raise
    except Exception as exc:
        raise EmailDeliveryError("AUTH_EMAIL_DELIVERY_FAILED") from exc