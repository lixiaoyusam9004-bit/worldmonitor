import type { CivilianFlight } from '@/types';
import { createCircuitBreaker } from '@/utils';
import { isFeatureAvailable } from './runtime-config';

const OPENSKY_PROXY_URL = '/api/opensky';
const wsRelayUrl = import.meta.env.VITE_WS_RELAY_URL || '';
const DIRECT_OPENSKY_BASE_URL = wsRelayUrl
  ? wsRelayUrl.replace('wss://', 'https://').replace('ws://', 'http://').replace(/\/$/, '') + '/opensky'
  : '';
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
    // Shuffle deterministically by icao24 and take first MAX_FLIGHTS
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

export async function fetchLiveFlights(): Promise<CivilianFlight[]> {
  if (!isFeatureAvailable('openskyRelay')) return [];

  return breaker.execute(async () => {
    if (cache && Date.now() - cache.timestamp < CACHE_TTL) {
      return cache.data;
    }

    const urls = [OPENSKY_PROXY_URL];
    if (isLocalhostRuntime && DIRECT_OPENSKY_BASE_URL) {
      urls.push(DIRECT_OPENSKY_BASE_URL);
    }

    for (const url of urls) {
      try {
        const res = await fetch(url, { headers: { Accept: 'application/json' } });
        if (!res.ok) {
          if (res.status === 429) console.warn('[Live Flights] Rate limited');
          continue;
        }
        const data: OpenSkyResponse = await res.json();
        const flights = parseResponse(data);
        cache = { data: flights, timestamp: Date.now() };
        return flights;
      } catch {
        continue;
      }
    }

    throw new Error('Live Flights: all sources failed');
  }, []);
}
