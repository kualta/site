// Mirrors Astro's origin check, with one exception for mail clients' signed
// RFC 8058 requests. The unsubscribe handler verifies the token before writing.
export function forbiddenFormOrigin(request: Request): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return false;
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  if (origin === url.origin) return false;
  const contentType = request.headers.get("Content-Type")?.toLowerCase();
  if (
    request.method === "POST" &&
    url.pathname === "/newsletter/unsubscribe" &&
    !origin &&
    contentType?.split(";")[0].trim() === "application/x-www-form-urlencoded"
  )
    return false;
  return (
    !contentType ||
    ["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"].some((type) =>
      contentType.includes(type),
    )
  );
}
