export function formatDayResult(username: string, date: string, total: number, target: number, met: boolean, streak: number): string {
  const icon = met ? "✅" : "❌";
  const fire = streak >= 1 ? "🔥 " : "";
  return `📊 ${username} — ${date}\n${total}/${target} ${icon} | ${fire}streak: ${streak}`;
}

export async function postDayResult(token: string, channel: string, username: string, date: string, total: number, target: number, met: boolean, streak: number): Promise<void> {
  const text = formatDayResult(username, date, total, target, met, streak);
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
