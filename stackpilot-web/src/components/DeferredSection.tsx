import { Suspense, useEffect, useRef, useState, type ReactNode } from 'react';

/** Reserve layout space and avoid starting video/WebGL engines offscreen. */
export function DeferredSection({ children, minHeight }: { children: ReactNode; minHeight: number }) {
  const element = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [reservedHeight, setReservedHeight] = useState(minHeight);
  useEffect(() => {
    if (!element.current) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: '120px' });
    observer.observe(element.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || !content.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.height > 0) setReservedHeight(Math.max(minHeight, entry.contentRect.height));
    });
    observer.observe(content.current);
    return () => observer.disconnect();
  }, [visible, minHeight]);
  return <div ref={element} style={{ minHeight: reservedHeight }}><Suspense fallback={<div style={{ minHeight }} aria-busy="true" />}>
    {visible ? <div ref={content}>{children}</div> : null}
  </Suspense></div>;
}
