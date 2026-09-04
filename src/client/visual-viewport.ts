import { createMeasure } from "measure-fn";

const viewportMeasure = createMeasure("viewport");

export type VisualViewportMetrics = {
  width: number;
  height: number;
  offsetTop: number;
  offsetLeft: number;
  scale: number;
};

export function normalizeVisualViewport(input: {
  width: number;
  height: number;
  offsetTop?: number;
  offsetLeft?: number;
  scale?: number;
}): VisualViewportMetrics {
  return {
    width: Math.max(1, Math.round(Number(input.width) || 1)),
    height: Math.max(1, Math.round(Number(input.height) || 1)),
    offsetTop: Math.max(0, Math.round(Number(input.offsetTop) || 0)),
    offsetLeft: Math.max(0, Math.round(Number(input.offsetLeft) || 0)),
    scale: Math.max(0.1, Number(input.scale) || 1),
  };
}

function sameViewport(
  a: VisualViewportMetrics | null,
  b: VisualViewportMetrics,
) {
  return Boolean(
    a &&
    a.width === b.width &&
    a.height === b.height &&
    a.offsetTop === b.offsetTop &&
    a.offsetLeft === b.offsetLeft &&
    Math.abs(a.scale - b.scale) < 0.001,
  );
}

export function createVisualViewportController() {
  let installed = false;
  let frame: number | null = null;
  let latest: VisualViewportMetrics | null = null;

  function read(): VisualViewportMetrics {
    const viewport = window.visualViewport;
    return normalizeVisualViewport({
      width: viewport?.width ?? window.innerWidth,
      height: viewport?.height ?? window.innerHeight,
      offsetTop: viewport?.offsetTop ?? 0,
      offsetLeft: viewport?.offsetLeft ?? 0,
      scale: viewport?.scale ?? 1,
    });
  }

  function apply(reason = "sync") {
    if (typeof window === "undefined" || typeof document === "undefined")
      return;
    const next = read();
    const changed = !sameViewport(latest, next);
    latest = next;

    const root = document.documentElement;
    root.style.setProperty("--pumptv-vv-width", `${next.width}px`);
    root.style.setProperty("--pumptv-vv-height", `${next.height}px`);
    root.style.setProperty("--pumptv-vv-top", `${next.offsetTop}px`);
    root.style.setProperty("--pumptv-vv-left", `${next.offsetLeft}px`);

    if (changed) {
      viewportMeasure.measureSync(
        {
          start: () => `Visual viewport · ${reason}`,
          end: (value) => value,
        },
        () => next,
      );
    }
  }

  function refresh(reason = "manual") {
    if (typeof window === "undefined") return;
    if (frame != null) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = null;
      apply(reason);
    });
  }

  function install() {
    if (installed || typeof window === "undefined") return;
    installed = true;
    apply("install");

    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", () => refresh("resize"), {
      passive: true,
    });
    viewport?.addEventListener("scroll", () => refresh("scroll"), {
      passive: true,
    });
    window.addEventListener("resize", () => refresh("window-resize"), {
      passive: true,
    });
    window.addEventListener("orientationchange", () => refresh("orientation"), {
      passive: true,
    });
  }

  return {
    install,
    refresh,
    metrics: () => latest,
  };
}
