/** Small helpers for talking to the gateway. Errors carry the HTTP status and a short body excerpt. */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    body: string,
  ) {
    super(`${url} returned HTTP ${status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
}

async function request(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (!res.ok) throw new HttpError(res.status, url, await res.text());
  return res;
}

export const getText = async (url: string) => (await request(url)).text();

export const getJson = async (url: string): Promise<unknown> => (await request(url)).json();

export async function postJson(url: string, body: unknown): Promise<unknown> {
  const res = await request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
