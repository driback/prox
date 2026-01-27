import { createFactory } from 'hono/factory';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { processResponseBody } from './hls.helper';

const factory = createFactory();

export const HlsController = factory.createHandlers(async (c) => {
  const rawUrl = c.req.query('url');
  if (!rawUrl) return c.text('No URL provided', 400);

  let targetUrl: URL;
  try {
    targetUrl = new URL(rawUrl);
  } catch {
    return c.text('Invalid URL provided', 400);
  }

  // 1. Setup AbortController for upstream timeouts
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    // 2. Prepare Headers
    const requestHeaders = new Headers();
    const range = c.req.header('range');
    const userAgent = c.req.header('user-agent');
    
    // Forward Range requests (vital for seeking in segments)
    if (range) requestHeaders.set('Range', range);
    // Forward UA or impersonate generic
    requestHeaders.set('User-Agent', userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    // Set Referer to target origin to bypass basic hotlink protection
    requestHeaders.set('Referer', targetUrl.origin);

    const upstream = await fetch(targetUrl.href, { 
      signal: controller.signal,
      headers: requestHeaders,
      redirect: 'follow', // Important: Follow redirects to find the actual file location
    });
    
    clearTimeout(timeout);

    if (!upstream.ok) {
      return c.text(
        `Upstream Error: ${upstream.status} ${upstream.statusText}`,
        upstream.status as ContentfulStatusCode
      );
    }

    // 3. Handle Content Type & Redirects
    const finalUrl = upstream.url || targetUrl.href;
    const upstreamType = upstream.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    
    // Detect M3U8 strictly by extension OR Mime type
    const isM3u8 = finalUrl.includes('.m3u8') || 
                   (upstreamType && /application\/vnd\.apple\.mpegurl|audio\/mpegurl/i.test(upstreamType));

    // Fallback content type if upstream is missing it
    const contentType = upstreamType || (isM3u8 ? 'application/vnd.apple.mpegurl' : 'video/mp2t');

// 4. Construct Response Headers
    const headers = new Headers({
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range',
      'Content-Disposition': 'inline',
      'Accept-Ranges': 'bytes', // Mandatory for seeking
      'Vary': 'Origin, Range',
    });

    // Cache Control
    if (isM3u8) {
      headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else {
      const cacheControl = upstream.headers.get('Cache-Control');
      if (cacheControl) headers.set('Cache-Control', cacheControl);
    }

    // Passthrough specific metadata
    ['Content-Range', 'Last-Modified', 'ETag'].forEach(key => {
      const value = upstream.headers.get(key);
      if (value) headers.set(key, value);
    });

    // --- FIX STARTS HERE ---
    
    // We strictly need Content-Length for segments (TS/MP4) to allow seeking.
    // Video segments are rarely gzipped by upstream (they are already compressed binaries).
    // If the upstream DID gzip it, fetch() decompressed it, so upstream Content-Length is invalid.
    
    const upstreamEncoding = upstream.headers.get('Content-Encoding');
    const upstreamLen = upstream.headers.get('Content-Length');
    
    // 1. If it is an M3U8, we are rewriting it, so size changes. Don't set Length.
    // 2. If Upstream is encoded (gzip/br), length doesn't match raw stream. Don't set Length.
    // 3. Otherwise (Standard Video Segment), FORWARD the Length.
    if (!isM3u8 && upstreamLen && !upstreamEncoding) {
      headers.set('Content-Length', upstreamLen);
    }
    
    // --- FIX ENDS HERE ---

    // 5. Stream Processor
    const stream = processResponseBody(upstream, contentType, finalUrl);

    return new Response(stream, {
      status: upstream.status as 200 | 206,
      headers,
    });
  } catch (err) {
    clearTimeout(timeout);
    console.error('HLS Proxy Error:', err);

    if (err instanceof DOMException && err.name === 'AbortError') {
      return c.text('Upstream timeout', 504);
    }

    return c.text('Internal Proxy Error', 502);
  }
});
