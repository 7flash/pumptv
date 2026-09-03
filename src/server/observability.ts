import { configure, createMeasure, safeStringify } from "measure-fn";

// PumpTV is a live system: measurement output is part of the operator surface,
// not an opt-in debug mode. Keep it visible in both the web and worker process.
configure({
  silent: false,
  timestamps: true,
  maxResultLength: 480,
  // Repository polling is frequent (heartbeats/state refresh). Keep those calls
  // measured, but only print root-level DB failures. DB work nested under an
  // HTTP request or generation span remains visible in that waterfall.
  logger: (event, next) => {
    if (event.scope === "db" && event.depth === 0 && event.type !== "error")
      return;
    next();
  },
});

export const httpMeasure = createMeasure("http");
export const dbMeasure = createMeasure("db");
export const falMeasure = createMeasure("fal");
export const generationMeasure = createMeasure("generation");
export const prewarmMeasure = createMeasure("prewarm");
export const showrunnerMeasure = createMeasure("showrunner");
export const referenceMeasure = createMeasure("reference");
export const reconcileMeasure = createMeasure("reconcile");
export const workerMeasure = createMeasure("worker");
export const pumpMeasure = createMeasure("pumpfun");
export const walletMeasure = createMeasure("wallet");
export const rewardMeasure = createMeasure("reward");
export const moderationMeasure = createMeasure("moderation");
export const arbitrationMeasure = createMeasure("arbitration");
export const lifecycleMeasure = createMeasure("lifecycle");
export const webMeasure = createMeasure("web");

function requestTag() {
  return `req_${Math.random().toString(36).slice(2, 8)}`;
}

export function errorText(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error ?? "Unknown error");
}

/**
 * Route-level measure-fn waterfall. Expected 4xx responses should be returned
 * by the handler; unexpected throws become a measured 500 response.
 */
export function measuredRoute(
  request: Request,
  handler: () => Response | Promise<Response>,
) {
  const url = new URL(request.url);
  const id = requestTag();
  return httpMeasure.measure(
    {
      start: () => `${request.method} ${url.pathname} ${id}`,
      end: (response: Response) => ({ status: response.status }),
      catch: (error) =>
        Response.json(
          {
            error: errorText(error),
            requestId: id,
          },
          { status: 500 },
        ),
    },
    handler,
  );
}

export { safeStringify };