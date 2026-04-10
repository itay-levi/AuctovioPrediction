import { Tooltip, Icon, Banner, Button, BlockStack, Text } from "@shopify/polaris";
import { QuestionCircleIcon } from "@shopify/polaris-icons";
import styles from "./ScenarioLabPanel.module.css";

export type LabPresetId = "" | "soft_launch" | "skeptic_audit" | "holiday_rush";

export type LabAudience = "general" | "professional" | "gen_z" | "luxury";

export const LAB_PRESETS: {
  id: Exclude<LabPresetId, "">;
  title: string;
  desc: string;
  audience: LabAudience;
  skepticism: 1 | 5 | 9;
  concern: string;
  brutality: number;
}[] = [
  {
    id: "soft_launch",
    title: "Soft launch",
    desc: "Friendly audience, low stress — best for new listings.",
    audience: "general",
    skepticism: 1,
    concern: "",
    brutality: 2,
  },
  {
    id: "skeptic_audit",
    title: "Skeptic audit",
    desc: "Professional buyers demanding evidence and proof.",
    audience: "professional",
    skepticism: 9,
    concern: "trust",
    brutality: 9,
  },
  {
    id: "holiday_rush",
    title: "Holiday rush",
    desc: "Gift buyers focused on shipping and delivery.",
    audience: "general",
    skepticism: 5,
    concern: "shipping",
    brutality: 5,
  },
];

const AUDIENCE_OPTIONS: { value: LabAudience; label: string }[] = [
  { value: "general", label: "General public" },
  { value: "professional", label: "Professional buyers" },
  { value: "gen_z", label: "Gen-Z shoppers" },
  { value: "luxury", label: "Luxury shoppers" },
];

const CONCERN_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Balanced — no forced focus" },
  { value: "price", label: "Price & value" },
  { value: "trust", label: "Trust & credibility" },
  { value: "shipping", label: "Shipping & delivery" },
  { value: "quality", label: "Quality & specifications" },
];

export type ScenarioLabPanelProps = {
  labEnabled: boolean;
  onLabEnabledChange: (enabled: boolean) => void;
  labPreset: LabPresetId;
  onSelectPreset: (id: Exclude<LabPresetId, "">) => void;
  onClearPreset: () => void;
  labAudience: LabAudience;
  onAudienceChange: (v: LabAudience) => void;
  labSkepticism: 1 | 5 | 9;
  onSkepticismChange: (v: 1 | 5 | 9) => void;
  labConcern: string;
  onConcernChange: (v: string) => void;
  labBrutality: number;
  onBrutalityChange: (v: number) => void;
  suggestedPreset?: "soft_launch" | "skeptic_audit" | "holiday_rush" | null;
};

function brutalityTierClass(n: number) {
  if (n <= 3) return styles.tierLenient;
  if (n <= 6) return styles.tierStandard;
  if (n <= 8) return styles.tierHard;
  return styles.tierMax;
}

function brutalityTierLabel(n: number) {
  if (n <= 3) return "Lenient";
  if (n <= 6) return "Standard";
  if (n <= 8) return "Hard";
  return "Maximum";
}

function HelpTip({ content }: { content: string }) {
  return (
    <Tooltip content={content}>
      <span className={styles.helpIcon} style={{ display: "inline-flex" }}>
        <Icon source={QuestionCircleIcon} tone="subdued" />
      </span>
    </Tooltip>
  );
}

export function ScenarioLabPanel({
  labEnabled,
  onLabEnabledChange,
  labPreset,
  onSelectPreset,
  onClearPreset,
  labAudience,
  onAudienceChange,
  labSkepticism,
  onSkepticismChange,
  labConcern,
  onConcernChange,
  labBrutality,
  onBrutalityChange,
  suggestedPreset,
}: ScenarioLabPanelProps) {
  const selectedPreset = labPreset ? LAB_PRESETS.find((p) => p.id === labPreset) : null;

  return (
    <div className={styles.shell}>
      <div className={styles.header}>
        <div className={styles.titleBlock}>
          <p className={styles.kicker}>Pro · Parallel simulation</p>
          <div className={styles.titleRow}>
            <h3 className={styles.title}>Scenario comparison lab</h3>
            <span className={styles.proBadge} aria-label="Pro feature">
              PRO
            </span>
          </div>
          <p className={styles.subtitle}>
            Run a <strong>general-public baseline</strong> alongside a <strong>target scenario</strong> so you can
            see score and friction deltas with one analysis.
          </p>
        </div>
        <div className={styles.switchWrap}>
          <span className={styles.switchLabel} id="lab-switch-label">
            Lab
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={labEnabled}
            aria-labelledby="lab-switch-label"
            className={styles.switch}
            data-on={labEnabled}
            onClick={() => onLabEnabledChange(!labEnabled)}
          >
            <span className={styles.switchThumb} />
          </button>
        </div>
      </div>

      {labEnabled && (
        <div className={styles.body}>
          {suggestedPreset && labPreset !== suggestedPreset && (
            <div style={{ marginBottom: 12 }}>
              <Banner tone="info" title="Suggested preset for this product">
                <BlockStack gap="200">
                  <Text as="p" variant="bodyMd">
                    Based on this product&apos;s top friction area, we recommend the{" "}
                    <strong>{LAB_PRESETS.find(p => p.id === suggestedPreset)?.title}</strong> preset:{" "}
                    {LAB_PRESETS.find(p => p.id === suggestedPreset)?.desc}
                  </Text>
                  <Button size="slim" onClick={() => onSelectPreset(suggestedPreset)}>
                    Apply {LAB_PRESETS.find(p => p.id === suggestedPreset)?.title}
                  </Button>
                </BlockStack>
              </Banner>
            </div>
          )}
          <p className={styles.sectionLabel}>Quick scenarios</p>
          <div className={styles.presets}>
            {LAB_PRESETS.map((p) => {
              const selected = labPreset === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  className={styles.preset}
                  data-selected={selected}
                  onClick={() => (selected ? onClearPreset() : onSelectPreset(p.id))}
                >
                  <span className={styles.presetTitle}>{p.title}</span>
                  <span className={styles.presetDesc}>{p.desc}</span>
                </button>
              );
            })}
          </div>
          {selectedPreset && <p className={styles.presetHint}>Active: {selectedPreset.desc}</p>}

          <div className={styles.divider} />

          <p className={styles.sectionLabel}>Manual overrides</p>

          <div className={styles.field}>
            <div className={styles.fieldHead}>
              <span className={styles.fieldLabel}>Target audience</span>
              <HelpTip content="Sets mindset and priorities: professionals weigh specs and ROI; luxury shoppers penalize cheap presentation; Gen-Z decides fast from visuals." />
            </div>
            <select
              className={styles.select}
              value={labAudience}
              aria-label="Target audience"
              onChange={(e) => {
                onClearPreset();
                onAudienceChange(e.target.value as LabAudience);
              }}
            >
              {AUDIENCE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <div className={styles.field}>
            <div className={styles.fieldHead}>
              <span className={styles.fieldLabel}>Skepticism level</span>
              <HelpTip content="How hard the panel pushes back: lenient panels emphasize strengths; auditors actively hunt for reasons to reject." />
            </div>
            <div className={styles.segmented} role="group" aria-label="Skepticism level">
              <button
                type="button"
                className={styles.segBtn}
                data-pressed={labSkepticism === 1}
                onClick={() => {
                  onClearPreset();
                  onSkepticismChange(1);
                }}
              >
                Lenient
                <span className={styles.segSub}>Benefit of the doubt</span>
              </button>
              <button
                type="button"
                className={styles.segBtn}
                data-pressed={labSkepticism === 5}
                onClick={() => {
                  onClearPreset();
                  onSkepticismChange(5);
                }}
              >
                Typical
                <span className={styles.segSub}>Balanced tradeoffs</span>
              </button>
              <button
                type="button"
                className={styles.segBtn}
                data-pressed={labSkepticism === 9}
                onClick={() => {
                  onClearPreset();
                  onSkepticismChange(9);
                }}
              >
                Skeptical
                <span className={styles.segSub}>Hunt for flaws</span>
              </button>
            </div>
            <p className={styles.fieldFoot}>
              {labSkepticism === 1 && "Panel emphasizes strengths; forgiving of minor gaps."}
              {labSkepticism === 5 && "Panel weighs pros and cons like most shoppers."}
              {labSkepticism === 9 && "Panel actively looks for reasons to reject."}
            </p>
          </div>

          <div className={styles.field}>
            <div className={styles.fieldHead}>
              <span className={styles.fieldLabel}>Core concern</span>
              <HelpTip content="Optionally force extra scrutiny on one dimension; leave balanced for an all-around read." />
            </div>
            <select
              className={styles.select}
              value={labConcern}
              aria-label="Core concern"
              onChange={(e) => {
                onClearPreset();
                onConcernChange(e.target.value);
              }}
            >
              {CONCERN_OPTIONS.map((o) => (
                <option key={o.value || "balanced"} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <div className={styles.field}>
            <div className={styles.brutalityHead}>
              <div className={styles.fieldHead} style={{ marginBottom: 0 }}>
                <span className={styles.fieldLabel}>Evidence bar (brutality)</span>
                <HelpTip content="How much proof the listing must show before a BUY vote. Higher levels demand concrete signals in the PDP text and imagery." />
              </div>
              <span className={`${styles.tierBadge} ${brutalityTierClass(labBrutality)}`}>
                {brutalityTierLabel(labBrutality)}
              </span>
            </div>
            <div className={styles.rangeWrap}>
              <input
                type="range"
                className={styles.range}
                min={1}
                max={10}
                step={1}
                value={labBrutality}
                aria-label="Brutality level"
                onChange={(e) => {
                  onClearPreset();
                  onBrutalityChange(Number(e.target.value));
                }}
              />
            </div>
            <div className={styles.rangeLabels}>
              <span>1 · Forgiving</span>
              <span>10 · Maximum scrutiny</span>
            </div>
            <p className={styles.fieldFoot}>
              {labBrutality <= 3 && "Balanced review — no extra evidence requirements."}
              {labBrutality >= 4 &&
                labBrutality <= 6 &&
                "Agents must name one specific weakness before voting BUY."}
              {labBrutality >= 7 &&
                labBrutality <= 8 &&
                "Requires two concrete listing signals to vote BUY; weak claims trend REJECT."}
              {labBrutality >= 9 &&
                "Maximum stress — strong evidence expected; default stance is conservative."}
            </p>
          </div>
        </div>
      )}

      {!labEnabled && (
        <p className={styles.collapsedHint}>
          Enable the lab to compare a <strong>general-public baseline</strong> with your scenario in one run. Uses the
          same MT budget as a standard analysis.
        </p>
      )}
    </div>
  );
}
