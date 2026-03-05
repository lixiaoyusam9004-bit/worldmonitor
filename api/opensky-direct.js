/**
 * Direct OpenSky proxy — no WS_RELAY_URL required.
 * Fetches from opensky-network.org server-side (bypasses CORS).
 * Used as fallback when the main relay is unavailable.
 */
import { getCorsHeaders } from './_cors.js';

export const config = { runtime: 'edge' };

const OPENSKY_BASE = 'https://opensky-network.org/api/states/all';
// Free tier: max 400 credits/day, 1 request per 10s per IP
const CACHE_SECONDS = 120;

export default async function handler(req) {
  const corsHeaders = getCorsHeaders(req, 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  try {
    // Forward bbox query params if present (lamin/lamax/lomin/lomax)
    const requestUrl = new URL(req.url);
    const search = requestUrl.search || '';
    const targetUrl = `${OPENSKY_BASE}${search}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 18000);

    let response;
    try {
      response = await fetch(targetUrl, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      return new Response(JSON.stringify({ error: 'OpenSky upstream error', status: response.status }), {
        status: response.status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    const body = await response.text();
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=60`,
        ...corsHeaders,
      },
    });
  } catch (err) {
    const isTimeout = err?.name === 'AbortError';
    return new Response(JSON.stringify({ error: isTimeout ? 'Timeout' : 'Fetch failed', details: String(err) }), {
      status: isTimeout ? 504 : 502,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
}
