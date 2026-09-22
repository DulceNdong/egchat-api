"""
Tests del KYCProvider — StubKYCProvider y factory get_kyc_provider().
"""
import pytest
from unittest.mock import patch

from app.services.kyc_provider import (
    StubKYCProvider, DocumentData, LivenessResult,
    KYCProviderError, get_kyc_provider,
)


# ── StubKYCProvider defaults ──────────────────────────────────────

@pytest.mark.asyncio
async def test_stub_extract_document_ok(stub_provider):
    doc = await stub_provider.extract_document(b"fake_image")
    assert isinstance(doc, DocumentData)
    assert doc.confidence == 0.92
    assert doc.expired    is False
    assert doc.is_valid() is True


@pytest.mark.asyncio
async def test_stub_verify_face_ok(stub_provider):
    score = await stub_provider.verify_face(b"selfie", b"doc")
    assert score == 0.91
    assert 0.0 <= score <= 1.0


@pytest.mark.asyncio
async def test_stub_liveness_ok(stub_provider):
    result = await stub_provider.check_liveness(b"selfie")
    assert isinstance(result, LivenessResult)
    assert result.passed is True
    assert result.score  == 0.95


@pytest.mark.asyncio
async def test_stub_verify_all_ok(stub_provider):
    result = await stub_provider.verify_all(b"doc", b"selfie")
    assert result.doc_ok      is True
    assert result.biometry_ok is True
    assert result.face_match_score == 0.91


# ── Modos de fallo ────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_stub_bad_ocr(stub_bad_ocr):
    doc = await stub_bad_ocr.extract_document(b"img")
    assert doc.confidence == 0.45
    assert doc.is_valid() is False   # confidence < 0.60


@pytest.mark.asyncio
async def test_stub_bad_face(stub_bad_face):
    score = await stub_bad_face.verify_face(b"s", b"d")
    assert score == 0.55
    assert score < 0.80


@pytest.mark.asyncio
async def test_stub_liveness_fail(stub_liveness_fail):
    result = await stub_liveness_fail.check_liveness(b"s")
    assert result.passed is False
    assert "STUB_LIVENESS_FAIL" in result.reason


@pytest.mark.asyncio
async def test_stub_expired_doc(stub_expired_doc):
    from datetime import date
    doc = await stub_expired_doc.extract_document(b"img")
    assert doc.expired is True
    assert date.fromisoformat(doc.expiry_date) < date.today()


@pytest.mark.asyncio
async def test_stub_verify_all_bad_biometry(stub_bad_ocr):
    result = await stub_bad_ocr.verify_all(b"doc", b"selfie")
    assert result.doc_ok is False   # confidence < 0.60


# ── Factory: selección de proveedor ──────────────────────────────

def test_factory_returns_stub_when_no_config():
    """Sin SMILE_ID configurado debe devolver StubKYCProvider."""
    with patch("app.services.kyc_provider.get_settings") as mock_s:
        mock_s.return_value.smile_id_partner_id = ""
        mock_s.return_value.smile_id_api_key    = ""
        mock_s.return_value.paddle_ocr_lang     = ""
        provider = get_kyc_provider()
    assert isinstance(provider, StubKYCProvider)


def test_factory_returns_smileid_when_configured():
    from app.services.kyc_provider import SmileIDProvider
    with patch("app.services.kyc_provider.get_settings") as mock_s:
        mock_s.return_value.smile_id_partner_id = "001"
        mock_s.return_value.smile_id_api_key    = "key123"
        mock_s.return_value.smile_id_env        = "sandbox"
        mock_s.return_value.paddle_ocr_lang     = ""
        provider = get_kyc_provider()
    assert isinstance(provider, SmileIDProvider)


# ── DocumentData.is_valid() ───────────────────────────────────────

def test_document_valid_requires_number_and_confidence():
    doc = DocumentData(doc_number="GQ-123", confidence=0.85, expired=False)
    assert doc.is_valid() is True


def test_document_invalid_no_number():
    doc = DocumentData(doc_number=None, confidence=0.90, expired=False)
    assert doc.is_valid() is False


def test_document_invalid_expired():
    doc = DocumentData(doc_number="GQ-123", confidence=0.90, expired=True)
    assert doc.is_valid() is False


def test_document_invalid_low_confidence():
    doc = DocumentData(doc_number="GQ-123", confidence=0.55, expired=False)
    assert doc.is_valid() is False   # < 0.60


# ── KYCProviderError ──────────────────────────────────────────────

def test_kyc_provider_error_message():
    err = KYCProviderError("SmileID", "timeout", 408)
    assert "[SmileID]" in str(err)
    assert err.provider    == "SmileID"
    assert err.status_code == 408
