/** Keep custom icons as inert vectors, including when restored from an older settings export. */
export function sanitizeIconSvg(input: string): string {
  if (!input || input.length > 131072 || typeof DOMParser === "undefined") return "";
  const start = input.indexOf("<svg");
  const end = input.lastIndexOf("</svg>");
  if (start < 0 || end < start) return "";
  const document = new DOMParser().parseFromString(input.slice(start, end + 6), "image/svg+xml");
  if (document.querySelector("parsererror") || document.documentElement.localName !== "svg") return "";
  const tags = new Set(["svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "defs", "linearGradient", "radialGradient", "stop", "clipPath", "mask", "use", "title", "desc", "text", "tspan"]);
  const attributes = new Set(["xmlns", "viewBox", "width", "height", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "d", "points", "fill", "fill-rule", "fill-opacity", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "stroke-dashoffset", "stroke-opacity", "opacity", "transform", "id", "class", "clip-path", "clip-rule", "mask", "gradientUnits", "gradientTransform", "offset", "stop-color", "stop-opacity", "href", "preserveAspectRatio", "role", "aria-label", "aria-hidden", "focusable", "font-size", "font-family", "text-anchor"]);
  for (const node of [document.documentElement, ...Array.from(document.querySelectorAll("*"))]) {
    if (!tags.has(node.localName)) { node.remove(); continue; }
    for (const attribute of Array.from(node.attributes)) {
      const value = attribute.value.trim();
      const unsafeUrl = /url\s*\(/i.test(value) && !/^url\(\s*#[\w-]+\s*\)$/.test(value);
      if (!attributes.has(attribute.name) || unsafeUrl || /(?:javascript|data|https?):/i.test(value) && attribute.name !== "xmlns" || attribute.name === "href" && !/^#[\w-]+$/.test(value)) node.removeAttribute(attribute.name);
    }
  }
  return new XMLSerializer().serializeToString(document.documentElement);
}
