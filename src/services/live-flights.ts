import type { CivilianFlight } from '@/types';
import { createCircuitBreaker } from '@/utils';

const OPENSKY_PROXY_URL = '/api/opensky';
const wsRelayUrl = import.meta.env.VITE_WS_RELAY_URL || '';
const DIRECT_RELAY_URL = wsRelayUrl
  ? wsRelayUrl.replace('wss://', 'https://').replace('ws://', 'http://').replace(/\/$/, '') + '/opensky'
  : '';
// OpenSky public API — free tier, no credentials needed, supports CORS
const OPENSKY_PUBLIC_URL = 'https://opensky-network.org/api/states/all';

const isLocalhostRuntime =
  typeof window !== 'undefined' &&
  ['localhost', '127.0.0.1'].includes(window.location.hostname);

// Cache: refresh every 90 seconds
const CACHE_TTL = 90 * 1000;
let cache: { data: CivilianFlight[]; timestamp: number } | null = null;

// Max flights to display (prevents performance issues)
const MAX_FLIGHTS = 1500;

// OpenSky state array indices
type OpenSkyState = [
  string,        // 0 icao24
  string | null, // 1 callsign
  string,        // 2 origin_country
  number | null, // 3 time_position
  number,        // 4 last_contact
  number | null, // 5 longitude
  number | null, // 6 latitude
  number | null, // 7 baro_altitude (m)
  boolean,       // 8 on_ground
  number | null, // 9 velocity (m/s)
  number | null, // 10 true_track (deg)
  ...unknown[]
];

interface OpenSkyResponse {
  time: number;
  states: OpenSkyState[] | null;
}

function parseResponse(data: OpenSkyResponse): CivilianFlight[] {
  if (!data.states) return [];

  const now = new Date();
  const flights: CivilianFlight[] = [];

  for (const s of data.states) {
    const lat = s[6];
    const lon = s[5];
    if (lat === null || lon === null) continue;
    if (s[8]) continue; // skip on-ground

    const baroAlt = s[7];
    const velocity = s[9];
    const track = s[10];

    flights.push({
      id: s[0],
      callsign: (s[1] || '').trim() || s[0].toUpperCase(),
      originCountry: s[2],
      lat,
      lon,
      altitude: baroAlt ? Math.round(baroAlt * 3.28084) : 0,
      heading: track ?? 0,
      speed: velocity ? Math.round(velocity * 1.94384) : 0,
      onGround: s[8],
      lastSeen: now,
    });
  }

  // Sample down if too many
  if (flights.length > MAX_FLIGHTS) {
    flights.sort((a, b) => a.id.localeCompare(b.id));
    return flights.slice(0, MAX_FLIGHTS);
  }

  return flights;
}

const breaker = createCircuitBreaker<CivilianFlight[]>({
  name: 'Live Flights',
  maxFailures: 3,
  cooldownMs: 5 * 60 * 1000,
  cacheTtlMs: 5 * 60 * 1000,
});

/**
 * Build candidate URL list in priority order:
 *  1. Vercel relay (/api/opensky) — uses WS_RELAY_URL + credentials
 *  2. Direct relay URL (localhost dev only)
 *  3. OpenSky public API — free, no credentials, fallback for forks without WS_RELAY_URL
 */
function buildUrls(): string[] {
  const urls: string[] = [OPENSKY_PROXY_URL];
  if (isLocalhostRuntime && DIRECT_RELAY_URL) {
    urls.push(DIRECT_RELAY_URL);
  }
  // Always add public API as final fallback
  urls.push(OPENSKY_PUBLIC_URL);
  return urls;
}

export async function fetchLiveFlights(): Promise<CivilianFlight[]> {
  return breaker.execute(async () => {
    if (cache && Date.now() - cache.timestamp < CACHE_TTL) {
      return cache.data;
    }

    for (const url of buildUrls()) {
      try {
        const res = await fetch(url, { headers: { Accept: 'application/json' } });
        if (!res.ok) {
          if (res.status === 429) console.warn('[Live Flights] Rate limited on', url);
          continue;
        }
        const data: OpenSkyResponse = await res.json();
        const flights = parseResponse(data);
        if (flights.length === 0) continue; // try next source
        console.info(`[Live Flights] ${flights.length} flights from ${url}`);
        cache = { data: flights, timestamp: Date.now() };
        return flights;
      } catch {
        continue;
      }
    }

    throw new Error('Live Flights: all sources failed');
  }, []);
}
