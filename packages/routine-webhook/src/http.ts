import { setTimeout as delay } from 'node:timers/promises';

/** HTTP is allowed only on loopback for local tests and development. */
export function validateUrl(input: string, originOnly = false): URL {
  const url = new URL(input);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || input.includes('?') || input.includes('#') || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      (originOnly && url.pathname !== '/')) throw new Error('Expected a clean HTTPS origin or loopback HTTP URL');
  return url;
}
export function serverOrigin(input = process.env.NIA_TEAMS_URL || 'https://nia-teams.com'): string {
  return validateUrl(input, true).origin;
}
export class HttpError extends Error {
  constructor(public readonly status: number) { super(`HTTP request failed (${status})`); }
}
/** Never follow redirects or include server response bodies (which may contain secrets) in errors. */
export async function requestJson<T>(url: string, init: RequestInit = {}, retries = 0): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, { ...init, redirect: 'manual', signal: init.signal ?? AbortSignal.timeout(30_000) });
    } catch {
      if (attempt >= retries || init.signal?.aborted) throw new Error('Network request failed');
      await delay(100 * 2 ** attempt); continue;
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel(); throw new Error('Redirects are not allowed');
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status >= 500 && attempt < retries) { await delay(100 * 2 ** attempt); continue; }
      throw new HttpError(response.status);
    }
    return await response.json() as T;
  }
}
export function jsonRequest(body: unknown, token?: string): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) };
}
export function topicKey(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:/-]{1,256}$/.test(value)) throw new Error('Invalid topicKey');
}
