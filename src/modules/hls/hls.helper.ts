// ==============================
// Types
// ==============================
type UrlParts = {
  baseUrl: string; // The "folder" the m3u8 is in
  search: string;  // The query params (?token=abc)
};

// ==============================
// Constants & Regex
// ==============================
const MPEGURL_REGEX = /mpegurl/i;
// Regex to capture URI="..." inside tags. Handles optional whitespace.
const GENERIC_URI_REGEX = /URI\s*=\s*"([^"]+)"/g; 
const REWRITE_PREFIX = "/hls?url=";
const TEXT_ENCODER = new TextEncoder();

// ==============================
// Utilities
// ==============================
const createEmptyStream = (): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) { controller.close(); },
  });

const isAbsoluteUrl = (url: string): boolean => 
  /^(https?:)?\/\//i.test(url);

const createProxyUrl = (target: string): string =>
  `${REWRITE_PREFIX}${encodeURIComponent(target)}`;

const extractUrlParts = (finalUrl: string): UrlParts => {
  try {
    const url = new URL(finalUrl);
    // Remove the filename (playlist.m3u8) to get the base directory
    const pathname = url.pathname.substring(0, url.pathname.lastIndexOf("/") + 1);
    return {
      baseUrl: `${url.origin}${pathname}`,
      search: url.search,
    };
  } catch (e) {
    console.error("Failed to parse URL parts", e);
    return { baseUrl: "", search: "" };
  }
};

/**
 * Resolves a segment URL and merges original playlist query params (tokens).
 */
const buildCompleteUrl = (
  lineUri: string,
  parts: UrlParts
): string => {
  // 1. Resolve absolute URL
  let resolvedUrl: string;
  if (isAbsoluteUrl(lineUri)) {
    resolvedUrl = lineUri;
  } else {
    try {
      resolvedUrl = new URL(lineUri, parts.baseUrl).href;
    } catch {
      return lineUri; // Fallback if resolution fails
    }
  }

  // 2. Append original query params (e.g. tokens) if they exist
  // Only append if the segment doesn't already have them to avoid duplication
  if (parts.search) {
    try {
      const urlObj = new URL(resolvedUrl);
      const baseParams = new URLSearchParams(parts.search);
      
      baseParams.forEach((val, key) => {
        if (!urlObj.searchParams.has(key)) {
          urlObj.searchParams.set(key, val);
        }
      });
      return urlObj.href;
    } catch {
      // If URL parsing fails, return the resolved one without extra params
    }
  }

  return resolvedUrl;
};

// ==============================
// Line Processor
// ==============================
const processLine = (line: string, parts: UrlParts): string => {
  const cleanLine = line.trim();
  if (!cleanLine) return line;

  // Case A: Tags with URIs (e.g., #EXT-X-KEY:...,URI="key.php")
  if (cleanLine.startsWith("#")) {
    // Only process tags we know contain URIs
    if (cleanLine.startsWith("#EXT-X-MEDIA") || 
        cleanLine.startsWith("#EXT-X-MAP") || 
        cleanLine.startsWith("#EXT-X-KEY") ||
        cleanLine.startsWith("#EXT-X-I-FRAME-STREAM-INF")) {
      
      return cleanLine.replace(GENERIC_URI_REGEX, (match, uri) => {
        const fullUrl = buildCompleteUrl(uri, parts);
        return `URI="${createProxyUrl(fullUrl)}"`;
      });
    }
    return cleanLine;
  }

  // Case B: Stream Inf (Quality Levels) - The next line is a URL
  // We don't rewrite #EXT-X-STREAM-INF itself, we rewrite the NEXT line (the URL)
  // This logic is handled because the next line will hit "Case C" below.

  // Case C: Segment / Playlist URLs (Lines not starting with #)
  return createProxyUrl(buildCompleteUrl(cleanLine, parts));
};

// ==============================
// Streaming Logic
// ==============================
const streamPlaylistRewrite = (
  stream: ReadableStream<Uint8Array>,
  finalUrl: string
): ReadableStream<Uint8Array> => {
  const urlParts = extractUrlParts(finalUrl);

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const decoder = new TextDecoder();
      const reader = stream.getReader();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          // Split by newline, but carefully handle the last partial line
          const lines = buffer.split("\n");
          
          // The last element is either an empty string (if value ended in \n)
          // or the start of the NEXT line. We save it back to buffer.
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const processed = processLine(line, urlParts);
            controller.enqueue(TEXT_ENCODER.encode(`${processed}\n`));
          }
        }

        // Process any remaining buffer
        if (buffer) {
          const processed = processLine(buffer, urlParts);
          controller.enqueue(TEXT_ENCODER.encode(processed));
        }
      } catch (err) {
        console.error("Stream Rewrite Error:", err);
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
  finalUrl: string
): ReadableStream<Uint8Array> => {
  // If it's not an M3U8 playlist, return the raw stream immediately
  if (!MPEGURL_REGEX.test(contentType)) {
    return response.body ?? createEmptyStream();
  }

  if (!response.body) return createEmptyStream();

  return streamPlaylistRewrite(response.body, finalUrl);
};
