export const config = { runtime: 'edge' };

const DEFAULT_M3U = 'https://iptv-org.github.io/iptv/index.m3u';
let _cache = null;
let _cacheTime = 0;
const CACHE_TTL = 6 * 60 * 60 * 1000;

function parseM3U(text) {
  const lines = text.split('\n');
  const channels = [];
  let meta = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF:')) {
      const name = (line.match(/,(.+)$/) || [])[1]?.trim() || 'Unknown';
      const logo = (line.match(/tvg-logo="([^"]*)"/) || [])[1]?.trim() || '';
      const group = (line.match(/group-title="([^"]*)"/) || [])[1]?.trim() || '';
      meta = { name, logo, group };
    } else if (meta && !line.startsWith('#')) {
      channels.push({
        name: meta.name,
        logo: meta.logo,
        group: meta.group,
        url: line,
      });
      meta = null;
    }
  }

  return channels;
}

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const m3uUrl = searchParams.get('url') || DEFAULT_M3U;

  // ক্যাশ চেক করুন
  if (_cache && Date.now() - _cacheTime < CACHE_TTL) {
    return new Response(JSON.stringify(_cache), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  try {
    const parsed = new URL(m3uUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Invalid URL');
    }

    const upstream = await fetch(m3uUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(19_000),
    });

    if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);

    const text = await upstream.text();
    const channels = parseM3U(text);

    const response = {
      channels,
      totalCount: channels.length,
      timestamp: new Date().toISOString(),
    };

    // ক্যাশ সেভ করুন
    _cache = response;
    _cacheTime = Date.now();

    return new Response(JSON.stringify(response), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=3600',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (err) {
    console.error(err);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
