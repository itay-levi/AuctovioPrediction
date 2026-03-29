"""Pydantic models for the MiroShop API endpoints."""

from pydantic import BaseModel, HttpUrl
from typing import Optional


class SimulateRequest(BaseModel):
    simulationId: str
    shopDomain: str
    shopType: str
    productUrl: str
    productJson: dict
    agentCount: int          # 5 | 25 | 50
    callbackUrl: str


class DeltaRequest(BaseModel):
    simulationId: str
    originalSimulationId: str
    shopDomain: str
    shopType: str
    productJson: dict
    agentCount: int
    callbackUrl: str
    overrides: dict          # {"price": 29.99, "shipping_days": 3}


class ClassifyRequest(BaseModel):
    shopDomain: str
    catalogMetadata: dict    # from extractCatalogMetadata()
