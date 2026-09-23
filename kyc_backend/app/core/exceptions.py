"""Excepciones HTTP personalizadas para el sistema KYC/AML."""
from fastapi import status


class KYCException(Exception):
    def __init__(self, code: str, message: str, status_code: int = 400, details: dict | None = None):
        self.code = code
        self.message = message
        self.status_code = status_code
        self.details = details or {}
        super().__init__(message)


class KYCNotFound(KYCException):
    def __init__(self, msg: str = "Solicitud KYC no encontrada"):
        super().__init__("KYC_NOT_FOUND", msg, status.HTTP_404_NOT_FOUND)


class KYCAlreadySubmitted(KYCException):
    def __init__(self):
        super().__init__("KYC_ALREADY_SUBMITTED",
                         "Ya tienes una solicitud KYC enviada. No puedes enviar otra.", 409)


class KYCCannotResubmit(KYCException):
    def __init__(self, current_status: str):
        super().__init__("KYC_CANNOT_RESUBMIT",
                         f"No puedes reintentar en estado: {current_status}", 409)


class UploadError(KYCException):
    def __init__(self, detail: str = "Error al subir el archivo"):
        super().__init__("UPLOAD_ERROR", detail, 500)


class InsufficientRole(KYCException):
    def __init__(self, required: str):
        super().__init__("INSUFFICIENT_ROLE",
                         f"Se requiere rol: {required}", status.HTTP_403_FORBIDDEN)
