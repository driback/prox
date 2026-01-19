// ==============================
// Types
// ==============================
type UrlParts = {
  origin: string;
  pathname: string;
  search: string;
  baseUrl: string;
};

// ==============================
// Constants & Regex
// ==============================
const MPEGURL_REGEX = /mpegurl/i;
const GENERIC_URI_REGEX = /URI="([^"]+)"/;
const REWRITE_PREFIX = "/hls?url=";
// TEXT_ENCODER is stateless, so it's safe to keep global
const TEXT_ENCODER = new TextEncoder();

// ==============================
// Utilities
// ==============================
const createEmptyStream = (): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.close();
    },
  });

const isAbsoluteUrl = (url: string): boolean =>
  /^https?:\/\//i.test(url) || url.startsWith("//");

// Added encodeURIComponent back for safety
const createProxyUrl = (url: string): string =>
  `${REWRITE_PREFIX}${encodeURIComponent(url)}`;

const resolveUrl = (urlStr: string, baseUrl: string): string => {
  if (isAbsoluteUrl(urlStr)) {
    return urlStr;
  }
  try {
    return new URL(urlStr, baseUrl).href;
  } catch (err) {
    console.warn(`Failed to resolve URL: ${urlStr} against ${baseUrl}`, err);
    return urlStr;
  }
};

const extractUrlParts = (targetUrl: string): UrlParts => {
  const url = new URL(targetUrl);
  const pathname = url.pathname.substring(0, url.pathname.lastIndexOf("/"));
  const baseUrl = `${url.origin}${pathname}/`;

  return {
    origin: url.origin,
    pathname,
    search: url.search,
    baseUrl,
  };
};

/**
 * Merges segment params with base params.
 * Example: segment?v=1 + base?token=abc -> segment?v=1&token=abc
 */
const buildCompleteUrl = (
  segment: string,
  baseUrl: string,
  baseSearch: string
): string => {
  const resolved = resolveUrl(segment, baseUrl);

  if (!baseSearch) return resolved;

  try {
    const url = new URL(resolved);
    // If we have base params, append them carefully
    const baseParams = new URLSearchParams(baseSearch);

    baseParams.forEach((value, key) => {
      // Only append if the segment doesn't already have this key
      if (!url.searchParams.has(key)) {
        url.searchParams.append(key, value);
      }
    });

    return url.href;
  } catch {
    return resolved;
  }
};

// ==============================
// Line Processor
// ==============================
const processLine = (line: string, urlParts: UrlParts): string => {
  const cleanLine = line.trim();
  if (!cleanLine) return line;

  const { baseUrl, search } = urlParts;

  // --- Case A: Directives / Tags (Starts with #) ---
  if (cleanLine.startsWith("#")) {
    const isMedia = cleanLine.startsWith("#EXT-X-MEDIA:");
    const isMap = cleanLine.startsWith("#EXT-X-MAP:");
    const isKey = cleanLine.startsWith("#EXT-X-KEY:");

    if (isMedia || isMap || isKey) {
      return cleanLine.replace(GENERIC_URI_REGEX, (match, uri) => {
        try {
          const resolved = buildCompleteUrl(uri, baseUrl, search);
          return `URI="${createProxyUrl(resolved)}"`;
        } catch (err) {
          console.warn(`Failed to rewrite URI in tag: ${cleanLine}`, err);
          return match;
        }
      });
    }

    return cleanLine;
  }

  // --- Case B: Segment URIs (Everything else) ---
  try {
    const resolved = buildCompleteUrl(cleanLine, baseUrl, search);
    return createProxyUrl(resolved);
  } catch (err) {
    console.warn("Failed to process segment:", cleanLine, err);
    return cleanLine;
  }
};

// ==============================
// Streaming Logic
// ==============================
const streamPlaylistRewrite = (
  stream: ReadableStream<Uint8Array>,
  targetUrl: string
): ReadableStream<Uint8Array> => {
  const urlParts = extractUrlParts(targetUrl);

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      // Create a new TextDecoder for EACH request to avoid state corruption
      const decoder = new TextDecoder();
      const reader = stream.getReader();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const processed = processLine(line, urlParts);
            controller.enqueue(TEXT_ENCODER.encode(`${processed}\n`));
          }
        }

        if (buffer) {
          const processed = processLine(buffer, urlParts);
          controller.enqueue(TEXT_ENCODER.encode(processed));
        }
      } catch (err) {
        console.error("Stream processing error:", err);
        controller.error(err);
      } finally {
        controller.close();
      }
    },
  });
};

// ==============================
// Public Entry Point
// ==============================
export const processResponseBody = (
  response: Response,
  contentType: string,
  targetUrl: string
): ReadableStream<Uint8Array> => {
  if (!MPEGURL_REGEX.test(contentType)) {
    return response.body ?? createEmptyStream();
  }

  if (!response.body) {
    console.warn("No response body for HLS playlist");
    return createEmptyStream();
  }

  return streamPlaylistRewrite(response.body, targetUrl);
};
