"""
NicheClassifier — classifies a store's niche from catalog metadata
and generates 5 niche-specific archetype context blocks.

Runs once at install (~0.5 MT). Stored in DB and reused for all simulations.
Falls back to GENERAL_RETAIL if classification confidence is low.
"""

import json
from typing import TypedDict

from ...utils.llm_client import LLMClient


class StoreClassification(TypedDict):
    primary_niche: str
    niche_category: str
    customer_profile_summary: str
    typical_price_sensitivity: str  # "low" | "medium" | "high"
    purchase_frequency: str         # "one_time" | "recurring_monthly" | "seasonal"
    gift_purchase_likelihood: str   # "low" | "medium" | "high"
    confidence: float               # 0.0-1.0


class ArchetypeContext(TypedDict):
    archetype_id: str
    niche_context: str  # ~100 tokens of niche-specific expertise injected into base persona


GENERAL_RETAIL_FALLBACK: StoreClassification = {
    "primary_niche": "general retail",
    "niche_category": "general",
    "customer_profile_summary": "General online shoppers with varied motivations",
    "typical_price_sensitivity": "medium",
    "purchase_frequency": "one_time",
    "gift_purchase_likelihood": "medium",
    "confidence": 0.3,
}

CLASSIFICATION_PROMPT = """You are classifying a Shopify store's niche based on its product catalog.

Catalog metadata:
- Top product types: {top_types}
- Vendors/brands: {vendors}
- Sample product titles: {top_titles}
- Common tags: {all_tags}
- Total products: {total_products}

Return ONLY valid JSON with this exact structure:
{{
  "primary_niche": "string (e.g. 'premium cigars', 'dog accessories', 'streetwear')",
  "niche_category": "string (e.g. 'tobacco_and_smoking', 'pet_supplies', 'fashion')",
  "customer_profile_summary": "string (1 sentence describing the typical customer)",
  "typical_price_sensitivity": "low|medium|high",
  "purchase_frequency": "one_time|recurring_monthly|seasonal",
  "gift_purchase_likelihood": "low|medium|high",
  "confidence": 0.0-1.0
}}"""

ARCHETYPE_CONTEXT_PROMPT = """You are generating a niche-specific context block for a customer archetype.

Store niche: {primary_niche}
Customer profile: {customer_profile_summary}

Archetype: {archetype_name}
Archetype base persona: {base_persona}

Write a SHORT (3-4 sentences, ~100 tokens) niche-specific extension that makes this archetype
deeply knowledgeable about {primary_niche}. Include:
- What specific things they know about this niche
- What specific terminology or standards they use
- What their "dealbreaker" looks like in this niche specifically

Return ONLY the context text, no JSON, no preamble."""


class NicheClassifier:
    def __init__(self, llm: LLMClient):
        self.llm = llm

    def classify(self, catalog_metadata: dict) -> StoreClassification:
        prompt = CLASSIFICATION_PROMPT.format(
            top_types=", ".join(catalog_metadata.get("topTypes", [])) or "unknown",
            vendors=", ".join(catalog_metadata.get("vendors", [])) or "unknown",
            top_titles=", ".join(catalog_metadata.get("topTitles", [])[:5]) or "unknown",
            all_tags=", ".join(catalog_metadata.get("allTags", [])[:10]) or "none",
            total_products=catalog_metadata.get("totalProducts", 0),
        )

        try:
            raw = self.llm.chat(
                messages=[{"role": "user", "content": prompt}],
                temperature=0.3,
                max_tokens=300,
            )
            result = json.loads(raw)
            if result.get("confidence", 0) < 0.5:
                return GENERAL_RETAIL_FALLBACK
            return result  # type: ignore[return-value]
        except Exception:
            return GENERAL_RETAIL_FALLBACK

    def generate_archetype_contexts(
        self,
        classification: StoreClassification,
        archetypes: list,
    ) -> list[ArchetypeContext]:
        contexts: list[ArchetypeContext] = []

        for archetype in archetypes:
            prompt = ARCHETYPE_CONTEXT_PROMPT.format(
                primary_niche=classification["primary_niche"],
                customer_profile_summary=classification["customer_profile_summary"],
                archetype_name=archetype.name,
                base_persona=archetype.base_persona,
            )
            try:
                context_text = self.llm.chat(
                    messages=[{"role": "user", "content": prompt}],
                    temperature=0.5,
                    max_tokens=150,
                )
            except Exception:
                context_text = f"You are familiar with {classification['primary_niche']} products."

            contexts.append({
                "archetype_id": archetype.id,
                "niche_context": context_text.strip(),
            })

        return contexts
