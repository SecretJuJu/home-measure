// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useVisualViewport } from "./useVisualViewport";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("tracks keyboard resize and viewport panning and removes subscriptions on exit", () => {
  const viewport = Object.assign(new EventTarget(), { height: 834, offsetTop: 0 });
  const remove = vi.spyOn(viewport, "removeEventListener");
  vi.stubGlobal("visualViewport", viewport);
  const { result, unmount } = renderHook(useVisualViewport);
  expect(result.current).toEqual({ height: 834, top: 0 });
  act(() => { viewport.height = 360; viewport.dispatchEvent(new Event("resize")); });
  expect(result.current).toEqual({ height: 360, top: 0 });
  act(() => { viewport.offsetTop = 72; viewport.dispatchEvent(new Event("scroll")); });
  expect(result.current).toEqual({ height: 360, top: 72 });
  unmount();
  expect(remove).toHaveBeenCalledWith("resize", expect.any(Function));
  expect(remove).toHaveBeenCalledWith("scroll", expect.any(Function));
});

it("leaves the CSS viewport fallback active when VisualViewport is unavailable", () => {
  vi.stubGlobal("visualViewport", undefined);
  const { result } = renderHook(useVisualViewport);
  expect(result.current).toEqual({});
});
