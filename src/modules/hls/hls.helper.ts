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
// Regex patterns (compiled once)
// ==============================
const MPEGURL_REGEX = /mpegurl/i;
const SEGMENT_REGEX =
  /^(?!#)(.+\.(?:m3u8|ts|m4s|cmf[va]|m4[av]|mp4[av]|fmp4|aac|mp4|mov)|seg-.+\.(?:m4s|cmf[va]|m4[av]|mp4[av]|fmp4|aac|mp4|mov))(\?[^#\r\n]*)?$/gim;
const AUDIO_URI_REGEX = /URI="([^"]+)"/;
const MAP_URI_REGEX = /#EXT-X-MAP:URI="([^"]+)"/;

// ==============================
// Constants
// ==============================
const REWRITE_PREFIX = "/hls?url=";
const TEXT_DECODER = new TextDecoder();
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

const encodeProxyUrl = (url: string): string =>
  `${REWRITE_PREFIX}${encodeURIComponent(url)}`;

/**
 * Safely resolve a relative or absolute URL against a base URL
 */
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

/**
 * Extract URL parts needed for rewriting
 */
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
 * Build a complete URL from a segment, preserving or adding query params
 */
const buildCompleteUrl = (
  segment: string,
  baseUrl: string,
  baseSearch: string
): string => {
  const resolved = resolveUrl(segment, baseUrl);

  // If segment already has query params, don't append base search
  if (segment.includes("?")) {
    return resolved;
  }

  // Otherwise, append base query params if they exist
  if (baseSearch) {
    try {
      const url = new URL(resolved);
      url.search = baseSearch;
      return url.href;
    } catch {
      return resolved;
    }
  }

  return resolved;
};

// ==============================
// Line processor
// ==============================
const processLine = (line: string, urlParts: UrlParts): string => {
  const { baseUrl, search } = urlParts;

  // --- AUDIO tracks (master playlist) ---
  if (line.startsWith("#EXT-X-MEDIA:TYPE=AUDIO")) {
    const match = line.match(AUDIO_URI_REGEX);
    if (!match?.[1]) {
      return line;
    }

    try {
      const resolved = buildCompleteUrl(match[1], baseUrl, search);
      return line.replace(AUDIO_URI_REGEX, `URI="${encodeProxyUrl(resolved)}"`);
    } catch (err) {
      console.warn("Failed to process AUDIO URI:", match[1], err);
      return line;
    }
  }

  // --- EXT-X-MAP (init segments) ---
  if (line.startsWith("#EXT-X-MAP:")) {
    const match = line.match(MAP_URI_REGEX);
    if (!match?.[1]) {
      return line;
    }

    try {
      const resolved = buildCompleteUrl(match[1], baseUrl, search);
      return line.replace(
        MAP_URI_REGEX,
        `#EXT-X-MAP:URI="${encodeProxyUrl(resolved)}"`
      );
    } catch (err) {
      console.warn("Failed to process MAP URI:", match[1], err);
      return line;
    }
  }

  // --- Media segments / variant playlists ---
  return line.replace(SEGMENT_REGEX, (segment) => {
    try {
      const resolved = buildCompleteUrl(segment, baseUrl, search);
      return encodeProxyUrl(resolved);
    } catch (err) {
      console.warn("Failed to process segment:", segment, err);
      return segment;
    }
  });
};

// ==============================
// Streaming playlist rewriter
// ==============================
const streamPlaylistRewrite = (
  stream: ReadableStream<Uint8Array>,
  targetUrl: string
): ReadableStream<Uint8Array> => {
  const urlParts = extractUrlParts(targetUrl);

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = stream.getReader();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += TEXT_DECODER.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const processed = processLine(line, urlParts);
            controller.enqueue(TEXT_ENCODER.encode(`${processed}\n`));
          }
        }

        // Process remaining buffer
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
// Public entry
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
