type UrlParts = {
  baseUrl: string;
  search: string;
};

const MPEGURL_REGEX = /mpegurl|m3u8/i;
const GENERIC_URI_REGEX = /URI\s*=\s*"([^"]+)"/g; 
const REWRITE_PREFIX = "/hls?url=";

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
    const pathname = url.pathname.substring(0, url.pathname.lastIndexOf("/") + 1);
    return {
      baseUrl: `${url.origin}${pathname}`,
      search: url.search,
    };
  } catch {
    return { baseUrl: "", search: "" };
  }
};

const buildCompleteUrl = (lineUri: string, parts: UrlParts): string => {
  let resolvedUrl: string;
  
  if (isAbsoluteUrl(lineUri)) {
    resolvedUrl = lineUri;
  } else {
    try {
      resolvedUrl = new URL(lineUri, parts.baseUrl).href;
    } catch {
      return lineUri;
    }
  }

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
    } catch {}
  }

  return resolvedUrl;
};

const processLine = (line: string, parts: UrlParts): string => {
  const cleanLine = line.trim();
  if (!cleanLine) return line;

  if (cleanLine.startsWith("#")) {
    if (cleanLine.startsWith("#EXT-X-MEDIA") || 
        cleanLine.startsWith("#EXT-X-MAP") || 
        cleanLine.startsWith("#EXT-X-KEY") ||
        cleanLine.startsWith("#EXT-X-I-FRAME-STREAM-INF")) {
      
      return cleanLine.replace(GENERIC_URI_REGEX, (_, uri) => {
        const fullUrl = buildCompleteUrl(uri, parts);
        return `URI="${createProxyUrl(fullUrl)}"`;
      });
    }
    return cleanLine;
  }

  return createProxyUrl(buildCompleteUrl(cleanLine, parts));
};

const createHlsTransformer = (parts: UrlParts) => {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const processed = processLine(line, parts);
        controller.enqueue(encoder.encode(processed + '\n'));
      }
    },
    flush(controller) {
      if (buffer) {
        const processed = processLine(buffer, parts);
        controller.enqueue(encoder.encode(processed));
      }
    },
  });
};

export const processResponseBody = (
  response: Response,
  contentType: string,
  finalUrl: string
): ReadableStream<Uint8Array> => {
  const stream = response.body;
  if (!stream) return createEmptyStream();

  if (!MPEGURL_REGEX.test(contentType)) {
    return stream;
  }

  const contentLength = response.headers.get('Content-Length');
  if (contentLength && parseInt(contentLength) > 1024 * 1024 * 2) {
    return stream;
  }

  const urlParts = extractUrlParts(finalUrl);
  return stream.pipeThrough(createHlsTransformer(urlParts));
};