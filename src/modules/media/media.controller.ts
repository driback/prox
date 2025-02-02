import type { ContentfulStatusCode } from 'hono/utils/http-status';

import { createFactory } from 'hono/factory';
import { MAX_FILE_SIZE, MEDIA_CONTENT_TYPES } from './media.constant';
import { processResponseBody } from './media.helper';

const factory = createFactory();

export const MediaController = factory.createHandlers(async (c) => {
  const targetUrlString = c.req.query('url');
  if (!targetUrlString) {
    return c.text('No URL provided', 400);
  }

  try {
    const fetchOptions: RequestInit = {
      method: 'GET',
      headers: {
        Accept: 'video/*,audio/*,image/*',
        'Accept-Encoding': 'identity',
      },
    };

    const response = await fetch(targetUrlString, fetchOptions);
    if (!response.ok) {
      return c.text(
        `Fetch failed: ${response.status} ${response.statusText}`,
        response.status as ContentfulStatusCode
      );
    }

    const contentType = response.headers
      .get('content-type')
      ?.split(';')?.[0]
      ?.trim()
      .toLowerCase();
    if (!(contentType && MEDIA_CONTENT_TYPES.has(contentType))) {
      return c.text('Unsupported Media Type', 415);
    }

    const contentLength = response.headers.get('content-length');
    if (contentLength && Number.parseInt(contentLength, 10) > MAX_FILE_SIZE) {
      return c.text('File too large', 413);
    }

    const responseHeaders = new Headers({
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    });
    const allowedHeaders = [
      'content-type',
      'content-length',
      'accept-ranges',
      'content-range',
    ];

    for (const header of allowedHeaders) {
      const value = response.headers.get(header);
      if (value) {
        responseHeaders.set(header, value);
      }
    }

    const bodyStream = processResponseBody(response);

    return new Response(bodyStream, {
      status: 200,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error('Media Proxy Error:', error);

    const errorMessage = error instanceof Error ? error.message : 'Proxy Error';
    return c.text(errorMessage, 500);
  }
});
