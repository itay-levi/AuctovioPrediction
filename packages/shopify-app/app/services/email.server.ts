// Email digest via Resend (https://resend.com)
// Set RESEND_API_KEY in .env to enable; emails are silently skipped if unset.

function escHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL ?? "digest@mail.auctovio.com";

export async function sendWeeklyDigest(
  to: string,
  shopDomain: string,
  data: {
    healthScore: number;
    simulationCount: number;
    topFriction: string | null;
    topProducts: { name: string; score: number }[];
  }
): Promise<void> {
  if (!RESEND_API_KEY) {
    return; // Email disabled in dev
  }

  const safeDomain = escHtml(shopDomain);
  const frictionLabel = data.topFriction
    ? `The biggest barrier this week was <strong>${escHtml(data.topFriction)}</strong> friction.`
    : "No dominant friction pattern this week.";

  const productRows = data.topProducts
    .map((p) => `<tr><td>${escHtml(p.name)}</td><td>${p.score}/100</td></tr>`)
    .join("");

  const html = `
    <h2>CustomerPanel AI — Weekly Store Report</h2>
    <p>Here's how <strong>${safeDomain}</strong> performed this week.</p>
    <hr/>
    <h3>Store Health Score: ${data.healthScore}/100</h3>
    <p>${frictionLabel}</p>
    <p>Simulations run this week: <strong>${data.simulationCount}</strong></p>
    ${productRows ? `
    <h3>Top Products</h3>
    <table border="1" cellpadding="6" cellspacing="0">
      <thead><tr><th>Product</th><th>Score</th></tr></thead>
      <tbody>${productRows}</tbody>
    </table>` : ""}
    <hr/>
    <p style="font-size:12px;color:#666;">
      You're receiving this because you have CustomerPanel AI installed on ${safeDomain}.
    </p>
  `;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to,
      subject: `CustomerPanel AI — Weekly Store Digest for ${shopDomain}`,
      html,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Resend error ${res.status}: ${text}`);
  }
}
