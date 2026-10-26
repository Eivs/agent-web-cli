export interface Decoded {
  text: string;
  charset: string;
  warning?: string;
}

function charsetFromContentType(ct: string | null): string | undefined {
  const m = ct?.match(/charset\s*=\s*["']?([\w.:-]+)/i);
  return m?.[1]?.toLowerCase();
}

function sniffMetaCharset(bytes: Uint8Array): string | undefined {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
  const m =
    head.match(/<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i) ??
    head.match(/<\?xml[^>]+encoding\s*=\s*["']([\w.:-]+)["']/i);
  return m?.[1]?.toLowerCase();
}

export function decodeBody(bytes: Uint8Array, contentType: string | null): Decoded {
  // BOMs win over everything else.
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder("utf-8").decode(bytes.subarray(3)), charset: "utf-8" };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), charset: "utf-16le" };
  }

  const declared = charsetFromContentType(contentType) ?? sniffMetaCharset(bytes) ?? "utf-8";
  try {
    return { text: new TextDecoder(declared).decode(bytes), charset: declared };
  } catch {
    return {
      text: new TextDecoder("utf-8").decode(bytes),
      charset: "utf-8",
      warning: `Unsupported charset "${declared}" in this runtime; decoded as UTF-8, so some characters may be garbled.`,
    };
  }
}
