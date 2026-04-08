export function formatDayResult(username: string, date: string, total: number, target: number, met: boolean, streak: number, debt: number = 0): string {
  const icon = met ? "✅" : "❌";
  const debtPart = debt > 0 ? ` | debt: ${debt}` : "";
  const fire = streak >= 1 ? "🔥 " : "";
  return `📊 ${username} — ${date}\n${total}/${target} ${icon}${debtPart} | ${fire}streak: ${streak}`;
}

export async function postDayResult(token: string, channel: string, username: string, date: string, total: number, target: number, met: boolean, streak: number, debt: number = 0): Promise<void> {
  const text = formatDayResult(username, date, total, target, met, streak, debt);
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel, text }),
  });
  if (!res.ok) {
    console.error(`Slack API HTTP error: ${res.status}`);
    return;
  }
  const data = await res.json() as { ok: boolean; error?: string };
  if (!data.ok) {
    console.error(`Slack API error: ${data.error}`);
  }
}
