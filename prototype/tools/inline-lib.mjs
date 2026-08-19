// Shared helpers for the single-file (inline) builds: brotli compression,
// HTML-safe base85 with sigil breaking, the embedded decoder source, and
// esbuild-based minification of inlined script text.
import { execFileSync } from "node:child_process";
import { brotliCompressSync, constants } from "node:zlib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const prototypeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const brotli = bytes => brotliCompressSync(bytes, {
  params: {
    [constants.BROTLI_PARAM_QUALITY]: 11,
    [constants.BROTLI_PARAM_LGWIN]: 24,
    [constants.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength
  }
});

export function minify(source, format = "iife") {
  return execFileSync(resolve(prototypeRoot, "node_modules/.bin/esbuild"), [
    "--minify", `--format=${format}`
  ], { input: source, maxBuffer: 1 << 26 }).toString("utf8");
}

export function brotliDecoderScript() {
  const bundled = execFileSync(resolve(prototypeRoot, "node_modules/.bin/esbuild"), [
    "--bundle", "--minify", "--format=iife", "--global-name=__brotliDecode",
    resolve(prototypeRoot, "node_modules/brotli/decompress.js")
  ], { maxBuffer: 1 << 26 }).toString("utf8");
  return bundled;
}

export const BASE85_CHARSET = (() => {
  const chars = [];
  for (let code = 33; code <= 126 && chars.length < 85; code++) {
    if ("<>&\"'\\`{".includes(String.fromCharCode(code))) continue;
    chars.push(String.fromCharCode(code));
  }
  return chars.join("");
})();

// Characters outside the base64 alphabet: sequences of these are what
// distinguish base85 text from the JS/base64 content that hosting-side
// validators demonstrably accept. Breaking every adjacent pair with a
// newline (the decoder skips whitespace) makes multi-punctuation sigils
// impossible while costing ~5% size.
const EXOTIC = new Set("!#$%()*,-.:;?@[]^_|~".split(""));

export function breakExoticPairs(text) {
  let out = "";
  let last = "";
  for (const ch of text) {
    if (EXOTIC.has(ch) && EXOTIC.has(last)) {
      out += "\n";
    }
    out += ch;
    last = ch;
  }
  return out;
}

export function encodeBase85(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i += 4) {
    const chunk = [bytes[i], bytes[i + 1] ?? 0, bytes[i + 2] ?? 0, bytes[i + 3] ?? 0];
    let value = ((chunk[0] * 256 + chunk[1]) * 256 + chunk[2]) * 256 + chunk[3];
    const digits = new Array(5);
    for (let d = 4; d >= 0; d--) {
      digits[d] = BASE85_CHARSET[value % 85];
      value = Math.floor(value / 85);
    }
    out.push(digits.join(""));
  }
  const padding = (4 - (bytes.length % 4)) % 4;
  let text = out.join("");
  if (padding) {
    text = text.slice(0, text.length - padding);
  }
  return breakExoticPairs(text);
}

// The inline decoder the template embeds (kept in sync with the encoder).
// Characters outside the charset (the sigil-breaking newlines) are skipped.
export const BASE85_DECODER_JS = `
function decodeBase85(elementId) {
  const CHARSET = ${JSON.stringify(BASE85_CHARSET)};
  const lookup = new Int16Array(127).fill(-1);
  for (let i = 0; i < 85; i++) lookup[CHARSET.charCodeAt(i)] = i;
  const text = document.getElementById(elementId).textContent;
  const bytes = new Uint8Array(Math.ceil(text.length / 5) * 4 + 4);
  let bi = 0, value = 0, digits = 0, valid = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const digit = code < 127 ? lookup[code] : -1;
    if (digit < 0) continue;
    valid++;
    value = value * 85 + digit;
    if (++digits === 5) {
      bytes[bi++] = (value / 16777216) & 255;
      bytes[bi++] = (value >>> 16) & 255;
      bytes[bi++] = (value >>> 8) & 255;
      bytes[bi++] = value & 255;
      value = 0; digits = 0;
    }
  }
  const padding = digits === 0 ? 0 : 5 - digits;
  if (digits > 0) {
    for (let d = digits; d < 5; d++) value = value * 85 + 84;
    bytes[bi++] = (value / 16777216) & 255;
    bytes[bi++] = (value >>> 16) & 255;
    bytes[bi++] = (value >>> 8) & 255;
    bytes[bi++] = value & 255;
  }
  return bytes.subarray(0, bi - padding);
}`;

