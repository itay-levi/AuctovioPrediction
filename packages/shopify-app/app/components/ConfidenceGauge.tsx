// Customer Confidence Score — animated SVG arc gauge

interface Props {
  score: number;  // 0-100
  size?: number;
  variant?: "light" | "dark";
}

function scoreToColor(score: number, dark: boolean): string {
  if (dark) {
    if (score >= 70) return "#34d399"; // emerald-400
    if (score >= 45) return "#fbbf24"; // amber-400
    return "#fb7185";                  // rose-400
  }
  if (score >= 70) return "#2E7D32";
  if (score >= 45) return "#F57F17";
  return "#C62828";
}

function scoreToLabel(score: number): string {
  if (score >= 70) return "Strong";
  if (score >= 45) return "Mixed";
  return "Needs Work";
}

export function ConfidenceGauge({ score, size = 200, variant = "light" }: Props) {
  const dark = variant === "dark";
  const radius = size * 0.38;
  const cx = size / 2;
  const cy = size * 0.55;
  const strokeWidth = size * 0.09;

  // Arc spans 180° (from π to 2π, left to right)
  const startAngle = Math.PI;
  const endAngle = 2 * Math.PI;
  const totalAngle = endAngle - startAngle;
  const fillAngle = startAngle + (totalAngle * score) / 100;

  const arcPath = (from: number, to: number) => {
    const x1 = cx + radius * Math.cos(from);
    const y1 = cy + radius * Math.sin(from);
    const x2 = cx + radius * Math.cos(to);
    const y2 = cy + radius * Math.sin(to);
    const largeArc = to - from > Math.PI ? 1 : 0;
    return `M ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2}`;
  };

  const color = scoreToColor(score, dark);
  const trackColor = dark ? "rgba(255,255,255,0.1)" : "#E0E0E0";
  const labelColor = dark ? "rgba(255,255,255,0.45)" : "#616161";

  return (
    <div style={{ textAlign: "center" }}>
      <svg width={size} height={size * 0.65} aria-label={`Customer Confidence Score: ${score}`}>
        {/* Track */}
        <path
          d={arcPath(Math.PI, 2 * Math.PI)}
          fill="none"
          stroke={trackColor}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
        />
        {/* Fill */}
        {score > 0 && (
          <path
            d={arcPath(Math.PI, fillAngle)}
            fill="none"
            stroke={color}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
          />
        )}
        {/* Score label */}
        <text
          x={cx}
          y={cy - radius * 0.1}
          textAnchor="middle"
          fontSize={size * 0.22}
          fontWeight="700"
          fill={color}
        >
          {score}
        </text>
        <text
          x={cx}
          y={cy + size * 0.08}
          textAnchor="middle"
          fontSize={size * 0.08}
          fill={labelColor}
        >
          {scoreToLabel(score)}
        </text>
      </svg>
      <p style={{ margin: 0, fontSize: "12px", color: labelColor }}>
        Customer Confidence Score
      </p>
    </div>
  );
}
