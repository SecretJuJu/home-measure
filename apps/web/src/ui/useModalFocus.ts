import { useEffect, useRef, type RefObject } from "react";

/** The backdrop must be a direct body portal, so its siblings can safely become inert. */
export function useModalFocus(backdrop: RefObject<HTMLDivElement | null>, onClose: () => void) {
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; }, [onClose]);
  useEffect(() => {
    const root = backdrop.current;
    if (!root) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const siblings = Array.from(document.body.children).filter((element): element is HTMLElement => element instanceof HTMLElement && element !== root);
    const inertBefore = siblings.map((element) => element.hasAttribute("inert"));
    siblings.forEach((element) => element.setAttribute("inert", ""));
    root.querySelector<HTMLButtonElement>("button")?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close.current(); }
      if (event.key !== "Tab") return;
      const controls = Array.from(root.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]'));
      const first = controls[0]; const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      siblings.forEach((element, index) => { if (!inertBefore[index]) element.removeAttribute("inert"); });
      if (previous?.isConnected) previous.focus();
    };
  }, [backdrop]);
}
