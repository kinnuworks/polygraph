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

async function request(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (!res.ok) throw new HttpError(res.status, url, await res.text());
  return res;
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
