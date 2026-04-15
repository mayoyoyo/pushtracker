export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbed {
  title: string;
  color: number;
  fields: DiscordEmbedField[];
}

const COLOR_SUCCESS = 0x57F287;
const COLOR_FAILURE = 0xED4245;

export function buildDayResultEmbed(
  username: string,
  date: string,
  total: number,
  target: number,
  met: boolean,
  streak: number,
  debt: number = 0,
): DiscordEmbed {
  const icon = met ? "✅" : "❌";
  const streakWord = streak === 1 ? "day" : "days";
  const streakValue = streak >= 1 ? `🔥 ${streak} ${streakWord}` : `0 days`;
  const debtSuffix = debt > 0 ? ` (${debt} debt)` : "";

  const fields: DiscordEmbedField[] = [
    { name: "Pushups", value: `${icon} ${total} / ${target}${debtSuffix}`, inline: true },
    { name: "Streak", value: streakValue, inline: true },
  ];

  return {
    title: `📊 ${username} — ${date}`,
    color: met ? COLOR_SUCCESS : COLOR_FAILURE,
    fields,
  };
}

export async function postDayResult(
  webhookUrl: string,
  username: string,
  date: string,
  total: number,
  target: number,
  met: boolean,
  streak: number,
  debt: number = 0,
): Promise<void> {
  const embed = buildDayResultEmbed(username, date, total, target, met, streak, debt);
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      embeds: [embed],
      allowed_mentions: { parse: [] },
    }),
  });
  if (!res.ok) {
    console.error(`Discord webhook HTTP error: ${res.status}`);
  }
}
