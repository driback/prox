import { createFactory } from 'hono/factory';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { MAX_FILE_SIZE, MEDIA_CONTENT_TYPES } from './media.constant';
import { processResponseBody } from './media.helper';

const factory = createFactory();

export const MediaController = factory.createHandlers(async (c) => {
  const targetUrl = c.req.query('url');
  if (!targetUrl) return c.text('No URL provided', 400);

  const rangeHeader = c.req.header('range');

  const fetchOptions: RequestInit = {
    method: 'GET',
    headers: {
      Accept: 'video/*,audio/*,image/*',
      'Accept-Encoding': 'identity',
      ...(rangeHeader && { Range: rangeHeader }),
    },
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  fetchOptions.signal = controller.signal;

  try {
    const upstream = await fetch(targetUrl, fetchOptions);
    clearTimeout(timeout);

    if (!upstream.ok && upstream.status !== 206) {
      return c.text(
        `Fetch failed: ${upstream.status} ${upstream.statusText}`,
        upstream.status as ContentfulStatusCode
      );
    }

    const contentType = upstream.headers
      .get('content-type')
      ?.split(';')[0]
      ?.trim()
      .toLowerCase();
    if (!contentType || !MEDIA_CONTENT_TYPES.has(contentType)) {
      return c.text('Unsupported Media Type', 415);
    }

    const contentLength = upstream.headers.get('content-length');
    if (contentLength && Number.parseInt(contentLength, 10) > MAX_FILE_SIZE) {
      return c.text('File too large', 413);
    }

    const headers = new Headers({
      'Cache-Control': 'public, max-age=86400, must-revalidate',
      'Content-Disposition': 'inline',
      Vary: 'Range',
    });

    const passthroughHeaders = [
      'Content-Type',
      'Content-Length',
      'Accept-Ranges',
      'Content-Range',
    ];
    for (const key of passthroughHeaders) {
      const value = upstream.headers.get(key);
      if (value) headers.set(key, value);
    }

    return new Response(processResponseBody(upstream), {
      status: upstream.status === 206 ? 206 : 200,
      headers,
    });
  } catch (err) {
    clearTimeout(timeout);
    console.error('Media Proxy Error:', err);

    const message = err instanceof Error ? err.message : 'Proxy Error';
    return c.text(message, 500);
  }
});
