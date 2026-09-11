import { useEffect, useState, type CSSProperties } from "react";

/** Safari's keyboard changes the visual viewport independently of the layout viewport. */
export function useVisualViewport(): CSSProperties {
  const [viewport, setViewport] = useState<{ height: number; top: number } | null>(null);
  useEffect(() => {
    const visual = window.visualViewport;
    if (!visual) return;
    const update = () => setViewport({ height: visual.height, top: visual.offsetTop });
    update();
    visual.addEventListener("resize", update);
    visual.addEventListener("scroll", update);
    return () => { visual.removeEventListener("resize", update); visual.removeEventListener("scroll", update); };
  }, []);
  return viewport ? { height: viewport.height, top: viewport.top } : {};
}
