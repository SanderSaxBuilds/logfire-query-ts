/** A Logfire Cloud data region. */
export type Region = 'us' | 'eu';

/** The API base URL of each Logfire Cloud data region. */
export const REGION_BASE_URLS: Readonly<Record<Region, string>> = Object.freeze({
  us: 'https://logfire-us.pydantic.dev',
  eu: 'https://logfire-eu.pydantic.dev',
});

/**
 * Regions that only appear in tokens for Logfire's own staging deployments.
 * The Python SDK maps them the same way.
 */
const STAGING_BASE_URLS: Readonly<Record<string, string>> = Object.freeze({
  stagingus: 'https://logfire-us.pydantic.info',
  stagingeu: 'https://logfire-eu.pydantic.info',
});

/** Matches the region part of a token such as `pylf_v1_eu_...`. Same pattern as the Python SDK. */
const TOKEN_REGION_PATTERN = /^pylf_v[0-9]+_([a-z]+)_/;

/** Returns the region name written in a token, or `undefined` for tokens made before regions existed. */
export function tokenRegion(token: string): string | undefined {
  const match = TOKEN_REGION_PATTERN.exec(token);
  return match?.[1];
}

/**
 * Returns the API base URL for a read token, from the region written in the token.
 *
 * Tokens created before regions were added have no region and use the US region.
 * A region this package does not know also falls back to the US region, and `onUnknownRegion`
 * is called with its name so the caller can warn about it.
 */
export function baseUrlFromToken(token: string, onUnknownRegion?: (region: string) => void): string {
  const region = tokenRegion(token);
  if (region === undefined) {
    return REGION_BASE_URLS.us;
  }
  const staging = STAGING_BASE_URLS[region];
  if (staging !== undefined) {
    return staging;
  }
  if (region === 'us' || region === 'eu') {
    return REGION_BASE_URLS[region];
  }
  onUnknownRegion?.(region);
  return REGION_BASE_URLS.us;
}

/** Checks a base URL and removes trailing slashes, so paths can be appended to it. */
export function normalizeBaseUrl(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new TypeError(`Invalid Logfire base URL: ${JSON.stringify(baseUrl)}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new TypeError(`Logfire base URL must use http or https, got ${JSON.stringify(baseUrl)}`);
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new TypeError(`Logfire base URL must not have a query string or fragment, got ${JSON.stringify(baseUrl)}`);
  }
  return baseUrl.replace(/\/+$/, '');
}

/** Options that decide which base URL a client sends requests to. */
export interface BaseUrlOptions {
  readToken: string;
  baseUrl?: string | undefined;
  region?: Region | undefined;
  onUnknownRegion?: ((region: string) => void) | undefined;
}

/**
 * Resolves the base URL. An explicit `baseUrl` wins, then an explicit `region`,
 * then the region written in the read token.
 */
export function resolveBaseUrl(options: BaseUrlOptions): string {
  if (options.baseUrl !== undefined) {
    return normalizeBaseUrl(options.baseUrl);
  }
  if (options.region !== undefined) {
    const url = (REGION_BASE_URLS as Record<string, string | undefined>)[options.region];
    if (url === undefined) {
      throw new TypeError(`Unknown Logfire region ${JSON.stringify(options.region)}, expected "us" or "eu"`);
    }
    return url;
  }
  return baseUrlFromToken(options.readToken, options.onUnknownRegion);
}
