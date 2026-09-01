import { fileURLToPath } from "node:url";
import { measuredRoute } from "../../../src/server/observability.ts";

const logoPath = fileURLToPath(
  new URL("../../../public/pumptv-logo.png", import.meta.url),
);

export function GET(request: Request) {
  return measuredRoute(
    request,
    () =>
      new Response(Bun.file(logoPath), {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=86400",
        },
      }),
  );
}
