"""Pydantic models for the MiroShop API endpoints."""

from pydantic import BaseModel, HttpUrl
from typing import Optional


class LabConfig(BaseModel):
    """Optional Customer Lab configuration — shapes the agent panel's audience and mindset."""
    audience: str = "general"        # "general" | "professional" | "gen_z" | "luxury"
    skepticism: int = 5              # 1-10: 1-3=Fan, 4-7=Average, 8-10=Auditor
    coreConcern: str = ""            # "price" | "trust" | "shipping" | "quality" | ""
    brutalityLevel: int = 5          # 1-10: controls evidence requirements (1=lenient, 10=hard proof only)
    preset: str = ""                 # "soft_launch" | "skeptic_audit" | "holiday_rush" | ""


class SimulateRequest(BaseModel):
    simulationId: str
    shopDomain: str
    shopType: str
    productUrl: str
    productJson: dict
    agentCount: int          # 5 | 25 | 50
    callbackUrl: str
    focusAreas: list[str] = []  # e.g. ["trust_credibility", "price_value"]
    labConfig: Optional[LabConfig] = None


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


class LabCompareRequest(BaseModel):
    """Request body for the /miroshop/lab/compare endpoint."""
    productTitle: str
    baselineReport: dict   # reportJson from the baseline simulation
    targetReport: dict     # reportJson from the target (custom Lab) simulation
    baselineScore: int
    targetScore: int
    labConfig: LabConfig   # the Lab config used for the target run


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
