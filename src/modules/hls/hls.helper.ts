const URI_ATTR_REGEX = /URI="([^"]+)"/g;
const PART_URI_REGEX = /PART="([^"]+)"/g;
const PRELOAD_URI_REGEX = /URI="([^"]+)"/;
const BYTERANGE_URI_REGEX = /^(.*)$/;

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: false });

const createEmptyStream = (): ReadableStream<Uint8Array> =>
  new ReadableStream({ start: c => c.close() });

const isAlreadyProxied = (url: string) =>
  url.startsWith("/hls?url=");

const resolveAndProxyUrl = (targetPath: string, manifestBaseUrl: string): string => {
  try {
    const clean = targetPath.trim().replace(/;+$/, "");
    if (!clean || isAlreadyProxied(clean)) return clean;

    const resolved = new URL(clean, manifestBaseUrl).toString();
    return `/hls?url=${encodeURIComponent(resolved)}`;
  } catch {
    return targetPath;
  }
};

const rewriteAttributeUris = (line: string, baseUrl: string): string => {
  return line
    .replace(URI_ATTR_REGEX, (_, uri) => `URI="${resolveAndProxyUrl(uri, baseUrl)}"`)
    .replace(PART_URI_REGEX, (_, uri) => `PART="${resolveAndProxyUrl(uri, baseUrl)}"`);
};

const processLine = (line: string, manifestBaseUrl: string): string => {
  const rawLine = line.replace(/\r$/, "");
  const trimmed = rawLine.trim();

  if (!trimmed) return rawLine;

  // Comments / Tags
  if (trimmed.startsWith("#")) {
    // LL-HLS tags that contain URIs
    if (
      trimmed.startsWith("#EXT-X-MEDIA") ||
      trimmed.startsWith("#EXT-X-MAP") ||
      trimmed.startsWith("#EXT-X-KEY") ||
      trimmed.startsWith("#EXT-X-SESSION-KEY") ||
      trimmed.startsWith("#EXT-X-I-FRAME-STREAM-INF") ||
      trimmed.startsWith("#EXT-X-RENDITION-REPORT") ||
      trimmed.startsWith("#EXT-X-PART") ||
      trimmed.startsWith("#EXT-X-PRELOAD-HINT")
    ) {
      return rewriteAttributeUris(rawLine, manifestBaseUrl);
    }

    // EXT-X-SERVER-CONTROL has no URI, keep untouched
    return rawLine;
  }

  // Segment URL or Partial Segment URL
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
      let failed = false;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += TEXT_DECODER.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const processed = processLine(line, targetUrl);
            controller.enqueue(TEXT_ENCODER.encode(processed + "\n"));
          }
        }

        buffer += TEXT_DECODER.decode();
        if (buffer) {
          const processed = processLine(buffer, targetUrl);
          controller.enqueue(TEXT_ENCODER.encode(processed));
        }
      } catch (err) {
        failed = true;
        console.error("LL-HLS Rewrite Error:", err);
        controller.error(err);
      } finally {
        if (!failed) controller.close();
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
  const isPlaylist =
    targetUrl.includes(".m3u8") ||
    /mpegurl|x-mpegurl|octet-stream/i.test(contentType);

  if (!isPlaylist || !response.body) {
    return response.body ?? createEmptyStream();
  }

  return streamPlaylistRewrite(response.body, targetUrl);
};
