"""
Servicio de screening KYC — OFAC / UE / ONU / PEP / Adverse Media.

Estructura real, integrable con proveedores externos (WorldCheck, Dow Jones,
ComplyAdvantage, etc.) mediante la interfaz ScreeningProvider.

En esta versión incluye:
  - Stub interno con listas de prueba
  - Interfaz para conectar proveedor real via HTTP
  - Resultado normalizado → kyc_screening_results
"""
from __future__ import annotations
import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from uuid import UUID

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.kyc_application import KycApplication
from app.models.kyc_screening import KycScreeningResult

logger = logging.getLogger("egchat.kyc.screening")

# ── Tipos de screening ────────────────────────────────────────────
SCREENING_TYPES = ["SANCTIONS", "PEP", "ADVERSE_MEDIA"]


@dataclass
class ScreeningMatch:
    found: bool
    score: float | None = None           # 0.0–1.0
    details: dict = field(default_factory=dict)
    # details: { name, dob, nationality, lists: [], reason, source }


# ══════════════════════════════════════════════════════════════════
# Interfaz abstracta — permite intercambiar proveedor
# ══════════════════════════════════════════════════════════════════
class ScreeningProvider(ABC):
    @abstractmethod
    async def check_sanctions(self, name: str, dob: str | None, nationality: str) -> ScreeningMatch:
        ...

    @abstractmethod
    async def check_pep(self, name: str, dob: str | None, nationality: str) -> ScreeningMatch:
        ...

    @abstractmethod
    async def check_adverse_media(self, name: str, nationality: str) -> ScreeningMatch:
        ...


# ══════════════════════════════════════════════════════════════════
# Proveedor STUB (desarrollo / tests)
# Lista interna mínima para no bloquear el flujo en entorno local
# ══════════════════════════════════════════════════════════════════
# Nombres de prueba para simular matches (NO son reales)
_STUB_SANCTIONS_NAMES = {"TEST BLOQUEADO", "OFAC DEMO", "SANCTIONED PERSON"}
_STUB_PEP_NAMES       = {"POLITICO DEMO", "PEP TEST USER"}


class StubScreeningProvider(ScreeningProvider):
    """Stub para desarrollo — nunca produce matches reales."""

    async def check_sanctions(self, name: str, dob: str | None, nationality: str) -> ScreeningMatch:
        hit = name.upper() in _STUB_SANCTIONS_NAMES
        return ScreeningMatch(
            found=hit,
            score=0.98 if hit else 0.0,
            details={"source": "STUB_INTERNAL", "lists": ["OFAC", "EU", "UN"]} if hit else {},
        )

    async def check_pep(self, name: str, dob: str | None, nationality: str) -> ScreeningMatch:
        hit = name.upper() in _STUB_PEP_NAMES
        return ScreeningMatch(
            found=hit,
            score=0.95 if hit else 0.0,
            details={"source": "STUB_INTERNAL", "category": "PEP"} if hit else {},
        )

    async def check_adverse_media(self, name: str, nationality: str) -> ScreeningMatch:
        # El stub nunca produce adverse media matches
        return ScreeningMatch(found=False, score=0.0, details={})


# ══════════════════════════════════════════════════════════════════
# Proveedor externo genérico (ComplyAdvantage / Dow Jones / etc.)
# Activar configurando SCREENING_PROVIDER_URL y SCREENING_API_KEY
# ══════════════════════════════════════════════════════════════════
class ExternalScreeningProvider(ScreeningProvider):
    """
    Proveedor externo vía REST API.
    Adaptar _call() al contrato del proveedor real.
    """
    def __init__(self, base_url: str, api_key: str):
        self._base_url = base_url.rstrip("/")
        self._api_key  = api_key

    async def _call(self, endpoint: str, payload: dict) -> dict:
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.post(
                f"{self._base_url}/{endpoint}",
                json=payload,
                headers={"Authorization": f"Bearer {self._api_key}"},
            )
            r.raise_for_status()
            return r.json()

    async def check_sanctions(self, name: str, dob: str | None, nationality: str) -> ScreeningMatch:
        try:
            data = await self._call("sanctions", {"name": name, "dob": dob, "nationality": nationality})
            return ScreeningMatch(
                found=data.get("match", False),
                score=data.get("score"),
                details=data.get("details", {}),
            )
        except Exception as e:
            logger.warning("Sanctions check failed: %s", e)
            return ScreeningMatch(found=False, score=None, details={"error": str(e)})

    async def check_pep(self, name: str, dob: str | None, nationality: str) -> ScreeningMatch:
        try:
            data = await self._call("pep", {"name": name, "dob": dob, "nationality": nationality})
            return ScreeningMatch(
                found=data.get("match", False),
                score=data.get("score"),
                details=data.get("details", {}),
            )
        except Exception as e:
            logger.warning("PEP check failed: %s", e)
            return ScreeningMatch(found=False, score=None, details={"error": str(e)})

    async def check_adverse_media(self, name: str, nationality: str) -> ScreeningMatch:
        try:
            data = await self._call("adverse-media", {"name": name, "nationality": nationality})
            return ScreeningMatch(
                found=data.get("match", False),
                score=data.get("score"),
                details=data.get("details", {}),
            )
        except Exception as e:
            logger.warning("Adverse media check failed: %s", e)
            return ScreeningMatch(found=False, score=None, details={"error": str(e)})


# ══════════════════════════════════════════════════════════════════
# Orquestador — ejecuta los 3 checks y guarda en BD
# ══════════════════════════════════════════════════════════════════
def _get_provider() -> ScreeningProvider:
    """Selecciona proveedor según configuración."""
    from app.config import get_settings
    s = get_settings()
    url = getattr(s, "screening_provider_url", "")
    key = getattr(s, "screening_api_key", "")
    if url and key:
        return ExternalScreeningProvider(url, key)
    return StubScreeningProvider()


async def run_full_screening(
    db: AsyncSession,
    application: KycApplication,
    full_name: str,
    dob: str | None,
    nationality: str,
) -> dict[str, ScreeningMatch]:
    """
    Ejecuta SANCTIONS + PEP + ADVERSE_MEDIA y persiste los resultados.
    Devuelve dict {screening_type: ScreeningMatch}.
    """
    provider = _get_provider()

    results: dict[str, ScreeningMatch] = {}

    checks = [
        ("SANCTIONS",     provider.check_sanctions(full_name, dob, nationality)),
        ("PEP",           provider.check_pep(full_name, dob, nationality)),
        ("ADVERSE_MEDIA", provider.check_adverse_media(full_name, nationality)),
    ]

    import asyncio
    raw = await asyncio.gather(*[c[1] for c in checks], return_exceptions=True)

    for (stype, _), match_or_err in zip(checks, raw):
        if isinstance(match_or_err, Exception):
            logger.error("Screening %s error: %s", stype, match_or_err)
            match = ScreeningMatch(found=False, details={"error": str(match_or_err)})
        else:
            match = match_or_err  # type: ignore

        results[stype] = match

        row = KycScreeningResult(
            application_id=application.id,
            screening_type=stype,
            provider=provider.__class__.__name__,
            match_found=match.found,
            match_score=match.score,
            match_details=match.details,
        )
        db.add(row)

    logger.info(
        "Screening completo para %s — SANCTIONS:%s PEP:%s MEDIA:%s",
        application.id,
        results["SANCTIONS"].found,
        results["PEP"].found,
        results["ADVERSE_MEDIA"].found,
    )
    return results
