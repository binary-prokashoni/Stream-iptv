// api/get-channels.js — Vercel Serverless Function
// Fetches an M3U playlist from a URL, parses it into clean JSON,
// and returns it with Vercel Edge Cache headers (s-maxage=3600).

export const config = { runtime: 'edge' };

const DEFAULT_M3U = 'https://iptv-org.github.io/iptv/index.m3u';

/**
 * Parse raw M3U text into a clean array of channel objects.
 * Only extracts: name, logo, url, group
 */
function parseM3U(text) {
  const lines = text.split('\n');
  const channels = [];
  let meta = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF:')) {
      const name    = (line.match(/,(.+)$/)             || [])[1]?.trim() || 'Unknown';
      const logo    = (line.match(/tvg-logo="([^"]*)"/) || [])[1]?.trim() || '';
      const group   = (line.match(/group-title="([^"]*)"/) || [])[1]?.trim() || '';
      const tvgId   = (line.match(/tvg-id="([^"]*)"/)   || [])[1]?.trim() || '';
      meta = { name, logo, group, tvgId };
    } else if (meta && !line.startsWith('#')) {
      // This line is the stream URL
      channels.push({
        name:  meta.name,
        logo:  meta.logo,
        group: meta.group,
        url:   line,
      });
      meta = null;
    }
  }

  return channels;
}

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const m3uUrl = searchParams.get('url') || DEFAULT_M3U;

  // Basic URL validation — only allow http/https
  try {
    const parsed = new URL(m3uUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return new Response(JSON.stringify({ error: 'Invalid URL protocol' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid URL' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const upstream = await fetch(m3uUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; StreamVX/1.0)',
        'Accept': '*/*',
      },
      // Vercel Edge fetch supports cf options but a simple timeout is enough
      signal: AbortSignal.timeout(20_000),
    });

    if (!upstream.ok) {
      return new Response(
        JSON.stringify({ error: `Upstream returned ${upstream.status}` }),
        { status: 502, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const text = await upstream.text();
    const channels = parseM3U(text);

    const body = JSON.stringify({ count: channels.length, channels });

    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        // Serve cached response for 1 hour; revalidate in background for next hour
        'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=3600',
        // Allow any frontend origin (CORS)
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (err) {
    console.error('[get-channels]', err);
    return new Response(
      JSON.stringify({ error: 'Failed to fetch playlist', detail: err.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}