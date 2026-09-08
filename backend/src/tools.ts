/**
 * JARVIS's hands. Tools are declared in OpenAI function-call format (Groq
 * speaks it), executed server-side, and their results fed back into the model
 * loop. All keyless: time is local, weather is open-meteo, search is the
 * DuckDuckGo instant-answer API. open_url executes CLIENT-side — the server
 * only validates and relays it as an SSE action.
 */

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolResult {
  result: string;
  clientAction?: { type: "open_url"; url: string };
}

export const TOOL_DEFS = [
  {
    type: "function",
    function: {
      name: "get_time",
      description: "Current local date and time.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Current weather for a city.",
      parameters: {
        type: "object",
        properties: { city: { type: "string", description: "City name, e.g. 'Lahore'" } },
        required: ["city"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Quick web lookup for a fact or topic (instant-answer quality, not deep research).",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_url",
      description: "Open a website in the user's browser (new tab).",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "Full http(s) URL" } },
        required: ["url"],
      },
    },
  },
] as const;

const WMO: Record<number, string> = {
  0: "clear sky",
  1: "mainly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "fog",
  48: "rime fog",
  51: "light drizzle",
  53: "drizzle",
  55: "heavy drizzle",
  61: "light rain",
  63: "rain",
  65: "heavy rain",
  71: "light snow",
  73: "snow",
  75: "heavy snow",
  80: "rain showers",
  81: "rain showers",
  82: "violent rain showers",
  95: "thunderstorm",
  96: "thunderstorm with hail",
  99: "thunderstorm with heavy hail",
};

async function getWeather(city: string): Promise<string> {
  const geo = (await (
    await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`)
  ).json()) as { results?: { latitude: number; longitude: number; name: string; country?: string }[] };
  const hit = geo.results?.[0];
  if (!hit) return `no such place found: "${city}"`;
  const wx = (await (
    await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${hit.latitude}&longitude=${hit.longitude}&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m`,
    )
  ).json()) as {
    current?: {
      temperature_2m: number;
      apparent_temperature: number;
      relative_humidity_2m: number;
      weather_code: number;
      wind_speed_10m: number;
    };
  };
  const c = wx.current;
  if (!c) return "weather service returned nothing";
  return (
    `${hit.name}${hit.country ? ", " + hit.country : ""}: ${WMO[c.weather_code] ?? "code " + c.weather_code}, ` +
    `${c.temperature_2m}°C (feels ${c.apparent_temperature}°C), humidity ${c.relative_humidity_2m}%, wind ${c.wind_speed_10m} km/h`
  );
}

async function webSearch(query: string): Promise<string> {
  const json = (await (
    await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`)
  ).json()) as {
    AbstractText?: string;
    AbstractURL?: string;
    Answer?: string;
    RelatedTopics?: { Text?: string; FirstURL?: string }[];
  };
  const parts: string[] = [];
  if (json.Answer) parts.push(`answer: ${json.Answer}`);
  if (json.AbstractText) parts.push(`${json.AbstractText}${json.AbstractURL ? ` (${json.AbstractURL})` : ""}`);
  for (const t of (json.RelatedTopics ?? []).slice(0, 3)) {
    if (t.Text) parts.push(`- ${t.Text}${t.FirstURL ? ` (${t.FirstURL})` : ""}`);
  }
  return parts.length > 0 ? parts.join("\n") : "no instant answer — suggest opening a search page";
}

export function validUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

export async function execTool(call: ToolCall): Promise<ToolResult> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch {
    /* tolerate bad json — tools validate their own fields */
  }
  try {
    switch (call.function.name) {
      case "get_time": {
        const now = new Date();
        return { result: `${now.toLocaleString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone})` };
      }
      case "get_weather":
        return { result: await getWeather(String(args.city ?? "")) };
      case "web_search":
        return { result: await webSearch(String(args.query ?? "")) };
      case "open_url": {
        const url = validUrl(String(args.url ?? ""));
        if (!url) return { result: "invalid url — must be http(s)" };
        return { result: `opening ${url} in the user's browser`, clientAction: { type: "open_url", url } };
      }
      default:
        return { result: `unknown tool: ${call.function.name}` };
    }
  } catch (err) {
    return { result: `tool failed: ${(err as Error).message}` };
  }
}
