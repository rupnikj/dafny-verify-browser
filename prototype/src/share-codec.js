// Share-link codec: a Dafny program packed into a URL fragment. Fragments
// never reach any server, so the "code stays in your browser" property
// survives sharing — the program exists only in the link itself.
// Format: "dfl:" + base64url(deflate-raw(utf8)) via the native
// CompressionStream; "raw:" + base64url(utf8) where it is unavailable.

export function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function base64UrlToBytes(text) {
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, ch => ch.charCodeAt(0));
}

export async function encodeShareFragment(source) {
  const bytes = new TextEncoder().encode(source);
  if (typeof CompressionStream !== "function") {
    return "raw:" + bytesToBase64Url(bytes);
  }
  const deflated = new Uint8Array(await new Response(
    new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
  return "dfl:" + bytesToBase64Url(deflated);
}

export async function decodeShareFragment(fragment) {
  const split = fragment.indexOf(":");
  const format = fragment.slice(0, split);
  const bytes = base64UrlToBytes(fragment.slice(split + 1));
  if (format === "raw") {
    return new TextDecoder().decode(bytes);
  }
  if (format !== "dfl" || typeof DecompressionStream !== "function") {
    throw new Error("unsupported share-link format: " + format);
  }
  return new Response(
    new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).text();
}

/** The #code= fragment of a URL, or null. */
export function shareFragmentFrom(hash) {
  const match = hash.match(/^#code=([^&]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}
