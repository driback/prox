const URI_ATTR_REGEX = /URI="([^"]+)"/g;
const PART_URI_REGEX = /PART="([^"]+)"/g;

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: false });

const createEmptyStream = (): ReadableStream<Uint8Array> =>
  new ReadableStream({ start: (c) => c.close() });

const isAlreadyProxied = (url: string) => url.includes("/hls?url=");

/**
 * Resolves a target path against the manifest URL.
 * CRITICAL: Preserves query parameters (tokens) from the manifest URL 
 * if the target path is relative.
 */
const resolveAndProxyUrl = (targetPath: string, manifestBaseUrl: string): string => {
  try {
    const cleanPath = targetPath.trim();
    if (!cleanPath || isAlreadyProxied(cleanPath)) return cleanPath;

    const base = new URL(manifestBaseUrl);
    const resolvedUrl = new URL(cleanPath, base);

    // Fix: If the resolved URL has no query params, but the base did, 
    // inherit them. (Fixes token-protected streams)
    if (Array.from(resolvedUrl.searchParams).length === 0 && Array.from(base.searchParams).length > 0) {
      // Only inherit if the segment is on the same origin/path structure (heuristic)
      if (resolvedUrl.origin === base.origin) {
        resolvedUrl.search = base.search;
      }
    }

    return `/hls?url=${encodeURIComponent(resolvedUrl.toString())}`;
  } catch (e) {
    return targetPath;
  }
};

const rewriteAttributeUris = (line: string, baseUrl: string): string => {
  return line
    .replace(URI_ATTR_REGEX, (_, uri) => `URI="${resolveAndProxyUrl(uri, baseUrl)}"`)
    .replace(PART_URI_REGEX, (_, uri) => `PART="${resolveAndProxyUrl(uri, baseUrl)}"`);
};

const processLine = (line: string, manifestBaseUrl: string): string => {
  const rawLine = line.replace(/\r$/, ""); // Normalize line ending
  const trimmed = rawLine.trim();

  if (!trimmed) return rawLine;

  // 1. Pass through comments that are NOT specific URI tags
  if (trimmed.startsWith("#")) {
    if (
      trimmed.startsWith("#EXT-X-MEDIA") ||
      trimmed.startsWith("#EXT-X-MAP") || // Essential for fMP4
      trimmed.startsWith("#EXT-X-KEY") || // Essential for DRM/Encryption
      trimmed.startsWith("#EXT-X-SESSION-KEY") ||
      trimmed.startsWith("#EXT-X-I-FRAME-STREAM-INF") ||
      trimmed.startsWith("#EXT-X-RENDITION-REPORT") ||
      trimmed.startsWith("#EXT-X-PART") ||
      trimmed.startsWith("#EXT-X-PRELOAD-HINT")
    ) {
      return rewriteAttributeUris(rawLine, manifestBaseUrl);
    }
    return rawLine;
  }

  // 2. Rewrite Segment URLs
  return resolveAndProxyUrl(trimmed, manifestBaseUrl);
};

const streamPlaylistRewrite = (
  stream: ReadableStream<Uint8Array>,
  targetUrl: string
): ReadableStream<Uint8Array> => {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = stream.getReader();
      let buffer = "";
      
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += TEXT_DECODER.decode(value, { stream: true });
          
          // Split by newline, handle potential \r\n vs \n
          const lines = buffer.split("\n");
          // Keep the last partial line in the buffer
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const processed = processLine(line, targetUrl);
            controller.enqueue(TEXT_ENCODER.encode(processed + "\n"));
          }
        }

        // Flush remaining buffer
        if (buffer) {
          const processed = processLine(buffer, targetUrl);
          controller.enqueue(TEXT_ENCODER.encode(processed));
        }
      } catch (err) {
        console.error("HLS Rewrite Error:", err);
        controller.error(err);
      } finally {
        controller.close();
        reader.releaseLock();
      }
    },
  });
};

export const processResponseBody = (
  response: Response,
  contentType: string,
  targetUrl: string
): ReadableStream<Uint8Array> => {
  // Strict check for playlist content types
  const isPlaylist =
    targetUrl.includes(".m3u8") ||
    /mpegurl|x-mpegurl|vnd\.apple\.mpegurl/i.test(contentType);

  if (!isPlaylist || !response.body) {
    return response.body ?? createEmptyStream();
  }

  return streamPlaylistRewrite(response.body, targetUrl);
};
