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
    deltaParams: dict        # {"price": 29.99, "shippingDays": 3}


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
