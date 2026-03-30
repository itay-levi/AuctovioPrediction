/**
 * Simulation result types — shared between routes and components.
 * These mirror the JSON schema produced by the Python recommendation engine.
 */

export type RecommendationPriority = "High" | "Medium" | "Low";

export interface Recommendation {
  priority: RecommendationPriority;
  /** Specific, actionable title — max 8 words (e.g. "Add a 30-Day Return Policy") */
  title: string;
  /** The metric that improves (e.g. "Reduces cart abandonment") */
  impact: string;
  /** Names the specific panelist(s) and quotes their exact objection */
  the_why: string;
}

export type TrustKillerSeverity = "high" | "medium";

export interface TrustKiller {
  /** Machine key (e.g. "return_policy", "no_reviews") */
  signal: string;
  /** Human-readable label (e.g. "No Return Policy") */
  label: string;
  severity: TrustKillerSeverity;
  /** Actionable fix text shown to the merchant */
  fix: string;
  /**
   * "grows_over_time" — issue is market-maturity based (reviews, brand reputation),
   * not a listing flaw the merchant can fix today. Shown in a separate UI section.
   */
  category?: "grows_over_time";
}

export interface TrustAudit {
  /** 0–100 score based on trust signal presence */
  trustScore: number;
  hasReturnPolicy: boolean;
  hasSpecificReturn: boolean;
  hasShippingInfo: boolean;
  hasSpecificShipping: boolean;
  hasReviews: boolean;
  hasStrongSocialProof: boolean;
  hasContact: boolean;
  hasTrustBadges: boolean;
  trustKillers: TrustKiller[];
}
