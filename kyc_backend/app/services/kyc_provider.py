"""
Interfaz KYCProvider — abstrae OCR, biometría y liveness.

Implementaciones disponibles:
  StubKYCProvider      → desarrollo/tests, resultados configurables
  SmileIDProvider      → SmileID API (Africa-focused, disponible en GQ)
  PaddleOCRProvider    → OCR local con PaddleOCR (fallback offline)

Selección automática vía SMILE_ID_PARTNER_ID en entorno.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

import httpx

from app.config import get_settings

logger = logging.getLogger("egchat.kyc.provider")


# ══════════════════════════════════════════════════════════════════
# Data classes de resultado
# ══════════════════════════════════════════════════════════════════

@dataclass
class DocumentData:
    """Datos extraídos por OCR de un documento de identidad."""
    full_name:    str | None   = None
    doc_number:   str | None   = None
    birth_date:   str | None   = None   # "YYYY-MM-DD"
    expiry_date:  str | None   = None   # "YYYY-MM-DD"
    nationality:  str | None   = None
    doc_type:     str | None   = None   # "DNI" | "PASSPORT" | "RESIDENCE_PERMIT"
    confidence:   float        = 0.0    # 0.0–1.0
    expired:      bool         = False
    raw:          dict         = field(default_factory=dict)

    def is_valid(self) -> bool:
        """True si el documento tiene número y no está vencido con confianza ≥ 0.60."""
        return bool(self.doc_number) and not self.expired and self.confidence >= 0.60


@dataclass
class LivenessResult:
    passed:      bool
    score:       float = 0.0   # 0.0–1.0
    reason:      str   = ""
    raw:         dict  = field(default_factory=dict)


@dataclass
class VerificationResult:
    """Resultado consolidado de una sesión completa de verificación."""
    document:         DocumentData
    face_match_score: float          # 0.0–1.0
    liveness:         LivenessResult
    provider_name:    str
    raw_responses:    dict = field(default_factory=dict)

    # Flags de decisión rápida
    @property
    def doc_ok(self) -> bool:
        return self.document.is_valid()

    @property
    def biometry_ok(self) -> bool:
        return self.face_match_score >= 0.80 and self.liveness.passed


# ══════════════════════════════════════════════════════════════════
# Interfaz abstracta
# ══════════════════════════════════════════════════════════════════

class KYCProvider(ABC):
    """
    Contrato que deben cumplir todos los proveedores KYC.
    Cada método puede lanzar KYCProviderError si el servicio externo falla.
    """

    @abstractmethod
    async def extract_document(
        self,
        image_bytes: bytes,
        mime_type:   str = "image/jpeg",
    ) -> DocumentData:
        """OCR sobre la imagen del documento. Devuelve datos extraídos."""
        ...

    @abstractmethod
    async def verify_face(
        self,
        selfie_bytes:    bytes,
        doc_image_bytes: bytes,
    ) -> float:
        """Compara la selfie con la foto del documento. Devuelve score 0.0–1.0."""
        ...

    @abstractmethod
    async def check_liveness(
        self,
        selfie_bytes: bytes,
    ) -> LivenessResult:
        """Detecta si la selfie es de una persona real (anti-deepfake)."""
        ...

    async def verify_all(
        self,
        doc_bytes:    bytes,
        selfie_bytes: bytes,
        mime_type:    str = "image/jpeg",
    ) -> VerificationResult:
        """
        Ejecuta extract_document + verify_face + check_liveness en paralelo.
        Método de conveniencia — puede sobreescribirse si el proveedor
        tiene un endpoint unificado.
        """
        doc_task      = self.extract_document(doc_bytes, mime_type)
        liveness_task = self.check_liveness(selfie_bytes)

        doc_data, liveness = await asyncio.gather(doc_task, liveness_task)
        face_score = await self.verify_face(selfie_bytes, doc_bytes)

        return VerificationResult(
            document=doc_data,
            face_match_score=face_score,
            liveness=liveness,
            provider_name=self.__class__.__name__,
        )


class KYCProviderError(Exception):
    """Error comunicando con el proveedor KYC externo."""
    def __init__(self, provider: str, message: str, status_code: int | None = None):
        self.provider    = provider
        self.status_code = status_code
        super().__init__(f"[{provider}] {message}")


# ══════════════════════════════════════════════════════════════════
# StubKYCProvider — desarrollo y tests
# ══════════════════════════════════════════════════════════════════

class StubKYCProvider(KYCProvider):
    """
    Proveedor de prueba.
    Por defecto devuelve resultados que pasan todos los checks (LOW risk).
    Configurable mediante parámetros del constructor para simular fallos.
    """

    def __init__(
        self,
        ocr_confidence:   float = 0.92,
        face_match:       float = 0.91,
        liveness_passed:  bool  = True,
        liveness_score:   float = 0.95,
        force_expired:    bool  = False,
        force_bad_ocr:    bool  = False,   # confidence = 0.45
        force_bad_face:   bool  = False,   # face_match  = 0.55
        force_liveness_fail: bool = False,
    ):
        self._ocr_confidence  = 0.45  if force_bad_ocr    else ocr_confidence
        self._face_match      = 0.55  if force_bad_face   else face_match
        self._liveness_passed = False if force_liveness_fail else liveness_passed
        self._liveness_score  = 0.20  if force_liveness_fail else liveness_score
        self._force_expired   = force_expired

    async def extract_document(self, image_bytes: bytes, mime_type: str = "image/jpeg") -> DocumentData:
        from datetime import date, timedelta
        expiry = date.today() - timedelta(days=1) if self._force_expired else date(2030, 12, 31)
        return DocumentData(
            full_name   = "TEST USER STUB",
            doc_number  = "GQ-STUB-12345",
            birth_date  = "1990-01-01",
            expiry_date = expiry.isoformat(),
            nationality = "GQ",
            doc_type    = "DNI",
            confidence  = self._ocr_confidence,
            expired     = self._force_expired,
            raw         = {"provider": "stub", "confidence": self._ocr_confidence},
        )

    async def verify_face(self, selfie_bytes: bytes, doc_image_bytes: bytes) -> float:
        return self._face_match

    async def check_liveness(self, selfie_bytes: bytes) -> LivenessResult:
        return LivenessResult(
            passed = self._liveness_passed,
            score  = self._liveness_score,
            reason = "" if self._liveness_passed else "STUB_LIVENESS_FAIL",
            raw    = {"provider": "stub"},
        )


# ══════════════════════════════════════════════════════════════════
# SmileIDProvider — proveedor real para África/GQ
# https://docs.smileidentity.com/
# ══════════════════════════════════════════════════════════════════

class SmileIDProvider(KYCProvider):
    """
    Integración con SmileID — proveedor de verificación de identidad
    especializado en África, con cobertura en Guinea Ecuatorial.

    Variables de entorno requeridas:
      SMILE_ID_PARTNER_ID  — ID de socio SmileID
      SMILE_ID_API_KEY     — clave API
      SMILE_ID_ENV         — sandbox | production
    """

    _SANDBOX_URL    = "https://testapi.smileidentity.com/v1"
    _PRODUCTION_URL = "https://api.smileidentity.com/v1"

    def __init__(self, partner_id: str, api_key: str, env: str = "sandbox"):
        self._partner_id = partner_id
        self._api_key    = api_key
        self._base_url   = self._SANDBOX_URL if env == "sandbox" else self._PRODUCTION_URL
        self._timeout    = httpx.Timeout(15.0, connect=5.0)

    def _sign(self, timestamp: str) -> str:
        """HMAC-SHA256 del timestamp con la API key — requerido por SmileID."""
        msg = f"{self._partner_id}:{timestamp}"
        return hmac.new(
            self._api_key.encode(),
            msg.encode(),
            hashlib.sha256,
        ).hexdigest()

    def _auth_headers(self) -> dict[str, str]:
        ts = str(int(time.time()))
        return {
            "Authorization": f"Bearer {self._api_key}",
            "SmileID-Partner-ID": self._partner_id,
            "SmileID-Timestamp":  ts,
            "SmileID-Signature":  self._sign(ts),
        }

    async def _post(self, endpoint: str, payload: dict) -> dict:
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            r = await client.post(
                f"{self._base_url}/{endpoint}",
                json=payload,
                headers=self._auth_headers(),
            )
            if not r.is_success:
                raise KYCProviderError("SmileID", f"HTTP {r.status_code}: {r.text}", r.status_code)
            return r.json()

    async def extract_document(self, image_bytes: bytes, mime_type: str = "image/jpeg") -> DocumentData:
        """
        Usa el endpoint Document Verification de SmileID.
        Ref: https://docs.smileidentity.com/products/document-verification
        """
        b64 = base64.b64encode(image_bytes).decode()
        try:
            data = await self._post("doc_verification", {
                "partner_id":   self._partner_id,
                "country":      "GQ",
                "id_type":      "NATIONAL_ID",
                "front_image":  b64,
                "front_image_type": "2",   # base64
            })
        except KYCProviderError:
            raise
        except Exception as e:
            raise KYCProviderError("SmileID", f"extract_document error: {e}")

        actions   = data.get("actions", {})
        id_info   = data.get("id_info", {})
        full_data = data.get("full_data", {})
        confidence = float(data.get("confidence", 0.0)) / 100.0

        return DocumentData(
            full_name   = id_info.get("full_name"),
            doc_number  = id_info.get("id_number"),
            birth_date  = id_info.get("dob"),
            expiry_date = id_info.get("expiry_date"),
            nationality = id_info.get("country", "GQ"),
            doc_type    = id_info.get("id_type", "DNI"),
            confidence  = confidence,
            expired     = actions.get("document_check") == "Rejected",
            raw         = data,
        )

    async def verify_face(self, selfie_bytes: bytes, doc_image_bytes: bytes) -> float:
        """
        Usa SmileID Enhanced Document Verification o Biometric KYC.
        Ref: https://docs.smileidentity.com/products/biometric-kyc
        """
        selfie_b64  = base64.b64encode(selfie_bytes).decode()
        doc_b64     = base64.b64encode(doc_image_bytes).decode()
        try:
            data = await self._post("biometric_kyc", {
                "partner_id":        self._partner_id,
                "selfie_image":      selfie_b64,
                "selfie_image_type": "2",
                "front_image":       doc_b64,
                "front_image_type":  "2",
                "country":           "GQ",
            })
        except KYCProviderError:
            raise
        except Exception as e:
            raise KYCProviderError("SmileID", f"verify_face error: {e}")

        # SmileID devuelve ConfidenceValue 0–100
        confidence = float(data.get("ConfidenceValue", 0)) / 100.0
        return confidence

    async def check_liveness(self, selfie_bytes: bytes) -> LivenessResult:
        """
        Usa SmileID Smart Selfie™ para liveness check.
        Ref: https://docs.smileidentity.com/products/smart-selfie
        """
        b64 = base64.b64encode(selfie_bytes).decode()
        try:
            data = await self._post("smile_links/biometric_kyc", {
                "partner_id":        self._partner_id,
                "selfie_image":      b64,
                "selfie_image_type": "2",
            })
        except KYCProviderError:
            raise
        except Exception as e:
            raise KYCProviderError("SmileID", f"check_liveness error: {e}")

        actions     = data.get("actions", {})
        liveness_ok = actions.get("liveness_check", "").lower() == "passed"
        score_raw   = float(data.get("ConfidenceValue", 0)) / 100.0

        return LivenessResult(
            passed = liveness_ok,
            score  = score_raw,
            reason = "" if liveness_ok else actions.get("liveness_check", "FAILED"),
            raw    = data,
        )


# ══════════════════════════════════════════════════════════════════
# PaddleOCRProvider — OCR local (fallback sin conexión)
# Requiere: pip install paddleocr paddlepaddle
# ══════════════════════════════════════════════════════════════════

class PaddleOCRProvider(KYCProvider):
    """
    Proveedor de OCR local con PaddleOCR.
    Solo realiza extracción de texto — NO hace biometría facial.
    Para face match y liveness, hace fallback al StubProvider con
    scores conservadores que fuerzan MANUAL_REVIEW.

    Útil como fallback cuando SmileID no está disponible.
    """

    def __init__(self, lang: str = "en", use_gpu: bool = False):
        self._lang    = lang
        self._use_gpu = use_gpu
        self._ocr     = None   # inicialización lazy

    def _get_ocr(self):
        if self._ocr is None:
            try:
                from paddleocr import PaddleOCR  # type: ignore
                self._ocr = PaddleOCR(use_angle_cls=True, lang=self._lang,
                                       use_gpu=self._use_gpu, show_log=False)
            except ImportError:
                raise KYCProviderError("PaddleOCR", "paddleocr no instalado. Ejecuta: pip install paddleocr")
        return self._ocr

    async def extract_document(self, image_bytes: bytes, mime_type: str = "image/jpeg") -> DocumentData:
        import io
        import re
        try:
            import numpy as np
            from PIL import Image as PILImage

            img = PILImage.open(io.BytesIO(image_bytes)).convert("RGB")
            arr = np.array(img)

            # Ejecutar en thread pool para no bloquear el event loop
            loop = asyncio.get_event_loop()
            result = await loop.run_in_executor(None, self._get_ocr().ocr, arr, True)

            lines: list[str] = []
            total_conf = 0.0
            count = 0
            for line_group in (result or []):
                for item in (line_group or []):
                    if isinstance(item, (list, tuple)) and len(item) >= 2:
                        text_info = item[1]
                        if isinstance(text_info, (list, tuple)):
                            lines.append(str(text_info[0]))
                            total_conf += float(text_info[1])
                            count += 1

            avg_conf = total_conf / count if count > 0 else 0.0
            full_text = " ".join(lines)

            # Extraer campos básicos del texto con heurísticas simples
            doc_number = None
            for pattern in [r'\b[A-Z]{2}-?\d{6,10}\b', r'\b\d{9}\b', r'\bGQ[0-9A-Z]{7,}\b']:
                m = re.search(pattern, full_text)
                if m:
                    doc_number = m.group(0)
                    break

            return DocumentData(
                full_name  = None,    # PaddleOCR básico no hace NER
                doc_number = doc_number,
                confidence = avg_conf,
                expired    = False,   # no puede determinarlo sin NLP
                raw        = {"lines": lines, "avg_confidence": avg_conf},
            )
        except KYCProviderError:
            raise
        except Exception as e:
            raise KYCProviderError("PaddleOCR", f"extract_document error: {e}")

    async def verify_face(self, selfie_bytes: bytes, doc_image_bytes: bytes) -> float:
        # PaddleOCR no tiene capacidad de face matching — devolver score
        # conservador que fuerza MANUAL_REVIEW (< 0.80)
        logger.warning("PaddleOCRProvider.verify_face: sin capacidad facial, score conservador 0.70")
        return 0.70

    async def check_liveness(self, selfie_bytes: bytes) -> LivenessResult:
        # Sin capacidad de liveness — devolver resultado conservador
        logger.warning("PaddleOCRProvider.check_liveness: sin capacidad liveness, marcando manual_review")
        return LivenessResult(
            passed = False,
            score  = 0.0,
            reason = "PADDLE_NO_LIVENESS_CAPABILITY",
            raw    = {"provider": "PaddleOCR", "note": "liveness_not_supported"},
        )


# ══════════════════════════════════════════════════════════════════
# Factory — selecciona proveedor según configuración
# ══════════════════════════════════════════════════════════════════

def get_kyc_provider() -> KYCProvider:
    """
    Selecciona el proveedor KYC según variables de entorno.
    Prioridad: SmileID > PaddleOCR > Stub
    """
    s = get_settings()

    partner_id = getattr(s, "smile_id_partner_id", "")
    api_key    = getattr(s, "smile_id_api_key",    "")
    env        = getattr(s, "smile_id_env",         "sandbox")

    if partner_id and api_key:
        logger.info("KYCProvider: SmileID (%s)", env)
        return SmileIDProvider(partner_id, api_key, env)

    paddle_lang = getattr(s, "paddle_ocr_lang", "")
    if paddle_lang:
        logger.info("KYCProvider: PaddleOCR (%s)", paddle_lang)
        return PaddleOCRProvider(lang=paddle_lang)

    logger.warning("KYCProvider: StubKYCProvider (desarrollo — no usar en producción)")
    return StubKYCProvider()
