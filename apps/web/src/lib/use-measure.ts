import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The element's own content width, observed. The grid needs a real number to lay widgets out
 * against, and a wrong one is visible: widgets either overflow the page or leave a gap.
 */
export function useElementWidth<T extends HTMLElement>(): {
  ref: (node: T | null) => void;
  width: number;
  measured: boolean;
} {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);

  const ref = useCallback((node: T | null) => {
    observer.current?.disconnect();
    if (!node) return;
    const update = () => setWidth(node.clientWidth);
    update();
    observer.current = new ResizeObserver(update);
    observer.current.observe(node);
  }, []);

  useEffect(() => () => observer.current?.disconnect(), []);

  return { ref, width, measured: width > 0 };
}
