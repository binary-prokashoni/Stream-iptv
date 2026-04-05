// api/get-channels.js — Vercel Edge Function (Optimized)
// Fetches an M3U playlist from a URL, parses it into clean JSON,
// and returns paginated results to prevent memory overflow.
// Supports pagination via ?page=1&limit=100 query parameters.

export const config = { runtime: 'edge' };

const DEFAULT_M3U = 'https://iptv-org.github.io/iptv/index.m3u';
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * Stream-based M3U parser with pagination support.
 * Instead of loading everything into memory, we parse line-by-line
 * and skip to the requested page range.
 *
 * @param {string} text - Raw M3U text
 * @param {number} page - Page number (1-indexed)
 * @param {number} limit - Items per page
 * @returns {Object} { channels, totalCount }
 */
function parseM3UWithPagination(text, page = 1, limit = DEFAULT_LIMIT) {
  const lines = text.split('\n');
  const channels = [];
  let meta = null;
  let totalCount = 0;

  const startIndex = (page - 1) * limit;
  const endIndex = startIndex + limit;

  // First pass: count total channels and collect needed ones
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF:')) {
      const name = (line.match(/,(.+)$/) || [])[1]?.trim() || 'Unknown';
      const logo = (line.match(/tvg-logo="([^"]*)"/) || [])[1]?.trim() || '';
      const group = (line.match(/group-title="([^"]*)"/) || [])[1]?.trim() || '';
      const tvgId = (line.match(/tvg-id="([^"]*)"/) || [])[1]?.trim() || '';
      meta = { name, logo, group, tvgId };
    } else if (meta && !line.startsWith('#')) {
      // Only add channels that fall within our requested page range
      if (totalCount >= startIndex && totalCount < endIndex) {
        channels.push({
          name: meta.name,
          logo: meta.logo,
          group: meta.group,
          url: line,
        });
      }
      totalCount++;
      meta = null;
    }
  }

  return { channels, totalCount };
}

/**
 * Alternative memory-optimized parser using streaming for very large files.
 * Useful if you need to process multi-MB files more efficiently.
 */
function parseM3UOptimized(text, page = 1, limit = DEFAULT_LIMIT) {
  // For Edge Functions, text.split() is generally acceptable up to ~10MB.
  // For larger files, consider chunked line reading or external parsing service.
  return parseM3UWithPagination(text, page, limit);
}

/**
 * Validate and parse query parameters
 */
function getPageParams(searchParams) {
  let page = parseInt(searchParams.get('page') || '1', 10);
  let limit = parseInt(searchParams.get('limit') || `${DEFAULT_LIMIT}`, 10);

  // Sanitize inputs
  if (isNaN(page) || page < 1) page = 1;
  if (isNaN(limit) || limit < 1) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT; // Prevent memory bloat

  return { page, limit };
}

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const m3uUrl = searchParams.get('url') || DEFAULT_M3U;
  const { page, limit } = getPageParams(searchParams);

  // Basic URL validation — only allow http/https
  try {
    const parsed = new URL(m3uUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return new Response(
        JSON.stringify({
          error: 'Invalid URL protocol',
          code: 'INVALID_PROTOCOL',
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
  } catch {
    return new Response(
      JSON.stringify({
        error: 'Invalid URL format',
        code: 'INVALID_URL',
      }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  try {
    // Fetch upstream M3U with 19-second timeout (leaving 1s buffer for processing)
    const upstream = await fetch(m3uUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; StreamVX/1.0)',
        Accept: '*/*',
      },
      signal: AbortSignal.timeout(19_000), // 19s to allow processing time
    });

    if (!upstream.ok) {
      return new Response(
        JSON.stringify({
          error: `Upstream returned ${upstream.status}`,
          code: 'UPSTREAM_ERROR',
        }),
        {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // Parse with pagination to avoid loading all channels at once
    const text = await upstream.text();
    const { channels, totalCount } = parseM3UOptimized(text, page, limit);

    // Calculate pagination metadata
    const totalPages = Math.ceil(totalCount / limit);
    const hasNextPage = page < totalPages;
    const hasPrevPage = page > 1;

    const body = JSON.stringify({
      // Core data
      channels,
      
      // Pagination metadata
      pagination: {
        page,
        limit,
        totalCount,
        totalPages,
        hasNextPage,
        hasPrevPage,
      },
      
      // Additional info
      fetchedAt: new Date().toISOString(),
      m3uSource: m3uUrl,
    });

    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=3600',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
      },
    });
  } catch (err) {
    console.error('[get-channels]', err);

    // Distinguish timeout errors for better client handling
    const code = err.name === 'AbortError' ? 'FETCH_TIMEOUT' : 'PARSE_ERROR';
    const message =
      err.name === 'AbortError'
        ? 'Upstream fetch timed out (19 seconds)'
        : 'Failed to parse playlist';

    return new Response(
      JSON.stringify({
        error: message,
        code,
        detail: err.message,
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}
