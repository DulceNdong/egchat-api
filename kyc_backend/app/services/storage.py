"""
Servicio de almacenamiento — sube documentos KYC al bucket Supabase Storage.
Devuelve URL firmada (1 año) para almacenar cifrada en BD.
"""
import io
from app.config import get_settings
from app.core.exceptions import UploadError

settings = get_settings()


async def upload_kyc_document(
    file_bytes: bytes,
    file_name: str,
    content_type: str,
    user_id: str,
    doc_type: str,   # doc_front | doc_back | selfie
) -> str:
    """
    Sube un archivo al bucket kyc-docs de Supabase Storage.
    Ruta: {user_id}/{doc_type}_{timestamp}.{ext}
    Devuelve URL firmada válida 1 año.
    """
    try:
        from supabase import create_client, Client
        client: Client = create_client(settings.supabase_url, settings.supabase_service_key)

        path = f"{user_id}/{file_name}"
        client.storage.from_(settings.supabase_kyc_bucket).upload(
            path=path,
            file=file_bytes,
            file_options={"content-type": content_type, "upsert": "true"},
        )

        # URL firmada válida 1 año (365 * 24 * 3600 segundos)
        signed = client.storage.from_(settings.supabase_kyc_bucket).create_signed_url(
            path, expires_in=365 * 24 * 3600
        )
        url = signed.get("signedURL") or signed.get("data", {}).get("signedUrl", "")
        if not url:
            raise UploadError("Supabase no devolvió URL firmada")
        return url

    except UploadError:
        raise
    except Exception as e:
        raise UploadError(f"Error al subir a Supabase Storage: {e}")
