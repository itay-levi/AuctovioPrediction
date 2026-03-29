// Customer Panel Visualizer — grid of agent avatars colored by verdict
// Green = Buy, Red = Reject, Gray = Pending

interface AgentLog {
  agentId: string;
  archetype: string;
  verdict: string; // BUY | REJECT | ABSTAIN
  reasoning: string;
}

interface Props {
  agentCount: number; // total agents (5 | 25 | 50)
  logs: AgentLog[];
}

const ARCHETYPE_ICONS: Record<string, string> = {
  BudgetOptimizer: "💰",
  BrandLoyalist: "✨",
  ResearchAnalyst: "🔍",
  ImpulseDecider: "⚡",
  GiftSeeker: "🎁",
};

function AgentDot({
  log,
  index,
}: {
  log?: AgentLog;
  index: number;
}) {
  const verdict = log?.verdict ?? "PENDING";
  const color =
    verdict === "BUY"
      ? "#2E7D32"
      : verdict === "REJECT"
        ? "#C62828"
        : "#E0E0E0";

  const icon = log ? (ARCHETYPE_ICONS[log.archetype] ?? "👤") : "👤";
  const title = log
    ? `${log.archetype}: ${log.verdict}\n${log.reasoning}`
    : `Agent ${index + 1} (pending)`;

  return (
    <div
      title={title}
      style={{
        width: 32,
        height: 32,
        borderRadius: "50%",
        backgroundColor: color,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 14,
        cursor: log ? "pointer" : "default",
        flexShrink: 0,
      }}
      aria-label={title}
    >
      {icon}
    </div>
  );
}

export function SwarmGrid({ agentCount, logs }: Props) {
  const logMap = new Map(logs.map((l) => [l.agentId, l]));

  const buyCount = logs.filter((l) => l.verdict === "BUY").length;
  const rejectCount = logs.filter((l) => l.verdict === "REJECT").length;

  return (
    <div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          padding: "16px 0",
        }}
      >
        {Array.from({ length: agentCount }, (_, i) => {
          const agentId = `agent_${i}`;
          return (
            <AgentDot key={agentId} log={logMap.get(agentId)} index={i} />
          );
        })}
      </div>
      {logs.length > 0 && (
        <div style={{ display: "flex", gap: 16, fontSize: 13, color: "#616161" }}>
          <span>
            <span style={{ color: "#2E7D32", fontWeight: 600 }}>{buyCount}</span> would buy
          </span>
          <span>
            <span style={{ color: "#C62828", fontWeight: 600 }}>{rejectCount}</span> rejected
          </span>
        </div>
      )}
    </div>
  );
}
