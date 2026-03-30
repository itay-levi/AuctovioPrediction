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
    focusAreas: list[str] = []  # e.g. ["trust_credibility", "price_value"]


class DeltaRequest(BaseModel):
    simulationId: str
    originalSimulationId: str
    shopDomain: str
    shopType: str
    productJson: dict
    agentCount: int
    callbackUrl: str
    deltaParams: dict        # {"price": 29.99, "shippingDays": 3}
    focusAreas: list[str] = []
    priority: int = 1                           # 0=initial scan, 1=what-if (lower priority)
    # Original simulation context for comparison insight generation
    originalScore: Optional[int] = None
    originalFriction: Optional[dict] = None
    originalTrustAudit: Optional[dict] = None


class ClassifyRequest(BaseModel):
    shopDomain: str
    sampleProductTitles: list[str]


class SynthesizeAgentLog(BaseModel):
    archetype: str
    phase: int
    vote: str           # BUY | REJECT | ABSTAIN
    reasoning: str


class SynthesizeRequest(BaseModel):
    simulation_id: str
    product_title: str
    niche: str
    agent_logs: list[SynthesizeAgentLog]
