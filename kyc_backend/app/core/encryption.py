"""
Cifrado/descifrado AES-256-GCM para campos sensibles.
Se usa para: URLs de documentos, phone, email en kyc_personal_data,
             subject_id_num en SAR.
"""
import base64
import os
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from app.config import get_settings

_settings = get_settings()

def _get_key() -> bytes:
    """Derivar clave de 32 bytes desde la configuración (hex de 64 chars)."""
    key_hex = _settings.encryption_key
    if len(key_hex) != 64:
        raise ValueError("encryption_key debe ser 64 caracteres hex (32 bytes)")
    return bytes.fromhex(key_hex)


def encrypt(plaintext: str) -> str:
    """
    Cifra un string y devuelve base64(nonce + ciphertext).
    Formato: base64(12-byte-nonce || ciphertext || 16-byte-tag)
    """
    key = _get_key()
    nonce = os.urandom(12)          # 96 bits recomendado para GCM
    aesgcm = AESGCM(key)
    ct = aesgcm.encrypt(nonce, plaintext.encode(), None)
    return base64.b64encode(nonce + ct).decode()


def decrypt(ciphertext_b64: str) -> str:
    """Descifra un string cifrado con encrypt()."""
    key = _get_key()
    raw = base64.b64decode(ciphertext_b64.encode())
    nonce, ct = raw[:12], raw[12:]
    aesgcm = AESGCM(key)
    return aesgcm.decrypt(nonce, ct, None).decode()


def encrypt_if_present(value: str | None) -> str | None:
    """Cifra solo si el valor no es None."""
    return encrypt(value) if value else None


def decrypt_if_present(value: str | None) -> str | None:
    """Descifra solo si el valor no es None."""
    return decrypt(value) if value else None
