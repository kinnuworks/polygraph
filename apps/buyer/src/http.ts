/** Small helpers for talking to the gateway. Errors carry the HTTP status and a short body excerpt. */

/** A short, single-line view of a response body; proxies answer errors with whole HTML pages. */
export function excerpt(body: string): string {
  if (/^\s*<(!doctype|html)/i.test(body)) {
    const title = /<title>([^<]*)<\/title>/i.exec(body)?.[1]?.trim();
    return `HTML error page${title ? ` "${title}"` : ""}`;
  }
  return body.replace(/\s+/g, " ").trim().slice(0, 200);
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    body: string,
  ) {
    super(`${url} returned HTTP ${status}${body ? `: ${excerpt(body)}` : ""}`);
  }
}

const RATE_LIMIT_RETRIES = 3;

/** Seconds to wait before retrying a 429: the Retry-After header, else the gateway's "retry in N s" hint, else 2. */
function retryDelaySeconds(res: Response, body: string): number {
  const header = Number(res.headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) return Math.min(header, 30);
  const hinted = Number(/retry in (\d+(?:\.\d+)?) ?s/.exec(body)?.[1]);
  return Number.isFinite(hinted) && hinted > 0 ? Math.min(hinted, 30) : 2;
}

/** Fetches with a few polite retries when the gateway rate-limits us; any other error status throws. */
async function request(url: string, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    if (res.ok) return res;
    const body = await res.text();
    if (res.status !== 429 || attempt >= RATE_LIMIT_RETRIES) throw new HttpError(res.status, url, body);
    await new Promise((done) => setTimeout(done, retryDelaySeconds(res, body) * 1000));
  }
}

export const getText = async (url: string) => (await request(url)).text();

export const getJson = async (url: string): Promise<unknown> => (await request(url)).json();

export async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
