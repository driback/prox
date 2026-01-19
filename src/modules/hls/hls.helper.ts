const URI_ATTR_REGEX = /URI="([^"]+)"/g;
const PART_URI_REGEX = /PART="([^"]+)"/g;
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
    if (clean.startsWith('data:')) return clean;

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

  if (trimmed.startsWith('#EXTINF:')) return rawLine;
  if (trimmed.startsWith('#EXT-X-TARGETDURATION')) return rawLine;
  if (trimmed.startsWith('#EXT-X-VERSION')) return rawLine;
  if (trimmed.startsWith('#EXT-X-MEDIA-SEQUENCE')) return rawLine;
  if (trimmed.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE')) return rawLine;
  if (trimmed.startsWith('#EXT-X-ENDLIST')) return rawLine;
  if (trimmed.startsWith('#EXT-X-PLAYLIST-TYPE')) return rawLine;

  if (trimmed.startsWith("#")) {
    const uriTags = [
      "#EXT-X-MEDIA",
      "#EXT-X-MAP",
      "#EXT-X-KEY",
      "#EXT-X-SESSION-KEY",
      "#EXT-X-I-FRAME-STREAM-INF",
      "#EXT-X-RENDITION-REPORT",
      "#EXT-X-PART",
      "#EXT-X-PRELOAD-HINT"
    ];

    if (uriTags.some(tag => trimmed.startsWith(tag))) {
      return rewriteAttributeUris(rawLine, manifestBaseUrl);
    }

    return rawLine;
  }

  return resolveAndProxyUrl(trimmed, manifestBaseUrl);
};

const streamPlaylistRewrite = (
  stream: ReadableStream<Uint8Array>,
  targetUrl: string
): ReadableStream<Uint8Array> => {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = stream.getReader();
      let buffer = new Uint8Array(0);
      let failed = false;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const newBuffer = new Uint8Array(buffer.length + value.length);
          newBuffer.set(buffer);
          newBuffer.set(value, buffer.length);
          buffer = newBuffer;

          let newlineIndex;
          while ((newlineIndex = buffer.indexOf(0x0A)) !== -1) {
            const lineEnd = newlineIndex;
            const lineStart = buffer[newlineIndex - 1] === 0x0D ? newlineIndex - 1 : newlineIndex;
            const lineBytes = buffer.slice(0, lineEnd + 1);
            const line = TEXT_DECODER.decode(lineBytes);
            const processed = processLine(line, targetUrl);
            controller.enqueue(TEXT_ENCODER.encode(processed));
            buffer = buffer.slice(newlineIndex + 1);
          }
        }

        if (buffer.length > 0) {
          const line = TEXT_DECODER.decode(buffer);
          const processed = processLine(line, targetUrl);
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
