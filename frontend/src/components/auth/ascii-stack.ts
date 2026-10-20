type Point = [number, number, number];
type Projected = { x: number; y: number; depth: number };

export const ASCII_COLUMNS = 124;
export const ASCII_ROWS = 60;
export const STACK_REST = { yaw: .58, pitch: -.42, spread: .92 };

/** A small text rasterizer. Both the surfaces and edges are ASCII glyphs. */
export function renderAsciiStack(yaw: number, pitch: number, spread: number): string {
  const width = ASCII_COLUMNS;
  const height = ASCII_ROWS;
  const pixels = new Array<string>(width * height).fill(" ");
  const depths = new Float32Array(width * height).fill(Infinity);
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);

  function rotate([x, y, z]: Point): Point {
    const rx = x * cy + z * sy;
    const rz = -x * sy + z * cy;
    return [rx, y * cp - rz * sp, y * sp + rz * cp];
  }

  function camera(point: Point): Projected {
    const [x, y, z] = rotate(point);
    const depth = 7 + z;
    return { x: x * 7 / depth, y: -y * 7 / depth * .53, depth };
  }

  // Keep the complete stack centered and inside the text grid at every angle.
  const bounds: Projected[] = [];
  for (const layer of [-1, 0, 1]) {
    for (const x of [-1.7, 1.7]) for (const z of [-1.35, 1.35]) {
      for (const side of [-.1, .1]) bounds.push(camera([x, layer * spread + side, z]));
    }
  }
  const xs = bounds.map(p => p.x), ys = bounds.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const scale = Math.min((width - 26) / (maxX - minX), (height - 14) / (maxY - minY));
  function project(point: Point): Projected {
    const p = camera(point);
    return { x: width / 2 + (p.x - (minX + maxX) / 2) * scale, y: height / 2 + (p.y - (minY + maxY) / 2) * scale, depth: p.depth };
  }

  function put(x: number, y: number, depth: number, glyph: string) {
    const col = Math.round(x), row = Math.round(y);
    if (col < 0 || col >= width || row < 0 || row >= height) return;
    const i = row * width + col;
    if (depth <= depths[i] + .004) {
      depths[i] = depth;
      pixels[i] = glyph;
    }
  }

  function triangle(a: Projected, b: Projected, c: Projected, light: number) {
    const minX = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
    const minY = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
    const denominator = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
    if (Math.abs(denominator) < .001) return;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const u = ((b.y - c.y) * (x - c.x) + (c.x - b.x) * (y - c.y)) / denominator;
        const v = ((c.y - a.y) * (x - c.x) + (a.x - c.x) * (y - c.y)) / denominator;
        const w = 1 - u - v;
        if (u < -.015 || v < -.015 || w < -.015) continue;
        const shade = (x + y * 2) % 11;
        const glyph = shade === 0 ? "+" : shade < (light > .42 ? 4 : 2) ? ":" : shade === 7 ? "." : " ";
        // Spaces still occlude the lower plates: this is a solid text surface.
        put(x, y, u * a.depth + v * b.depth + w * c.depth, glyph);
      }
    }
  }

  function line(a: Projected, b: Projected) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const steps = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) * 2);
    const glyph = Math.abs(dy) < Math.abs(dx) * .32 ? "=" : Math.abs(dx) < Math.abs(dy) * .35 ? "#" : dx * dy > 0 ? "\\" : "/";
    for (let step = 0; step <= steps; step++) {
      const t = step / Math.max(1, steps);
      put(a.x + dx * t, a.y + dy * t, a.depth + (b.depth - a.depth) * t - .035, glyph);
    }
    put(a.x, a.y, a.depth - .04, "+");
    put(b.x, b.y, b.depth - .04, "+");
  }

  // Solid plates, separated along Y. Z-buffering hides rear faces and edges.
  const faces: { indices: number[]; normal: Point }[] = [
    { indices: [0, 1, 2, 3], normal: [0, 1, 0] },
    { indices: [4, 7, 6, 5], normal: [0, -1, 0] },
    { indices: [0, 4, 5, 1], normal: [0, 0, -1] },
    { indices: [3, 2, 6, 7], normal: [0, 0, 1] },
    { indices: [0, 3, 7, 4], normal: [-1, 0, 0] },
    { indices: [1, 5, 6, 2], normal: [1, 0, 0] },
  ];
  for (let layer = -1; layer <= 1; layer++) {
    const y = layer * spread;
    const vertices: Point[] = [
      [-1.7, y + .1, -1.35], [1.7, y + .1, -1.35],
      [1.7, y + .1, 1.35], [-1.7, y + .1, 1.35],
      [-1.7, y - .1, -1.35], [1.7, y - .1, -1.35],
      [1.7, y - .1, 1.35], [-1.7, y - .1, 1.35],
    ];
    const points = vertices.map(project);
    for (const face of faces) {
      const [nx, ny, nz] = rotate(face.normal);
      const light = Math.max(.05, Math.min(.77, .2 + nx * -.12 + ny * .25 - nz * .28));
      const [a, b, c, d] = face.indices.map(i => points[i]);
      triangle(a, b, c, light);
      triangle(a, c, d, light);
    }
    for (const indices of [[0, 1, 2, 3], [4, 5, 6, 7]]) {
      for (let i = 0; i < 4; i++) line(points[indices[i]], points[indices[(i + 1) % 4]]);
    }
    for (let i = 0; i < 4; i++) line(points[i], points[i + 4]);
    // Anchor the label to the plate but keep its characters on a clear baseline.
    const label = layer === 1 ? ["[01] FRONTEND", "</>  { COMPONENTS }"]
      : layer === 0 ? ["[02] API / SERVER", "{ routes : services }"] : ["[03] DATA LAYER", "[ tables : storage ]"];
    const center = project([0, y + .12, layer === 1 ? 0 : -.8]);
    for (let row = 0; row < label.length; row++) {
      const value = " " + label[row] + " ";
      for (let col = 0; col < value.length; col++) put(center.x - value.length / 2 + col, center.y + row * 2 - 1, -Infinity, value[col]);
    }
  }
  return Array.from({ length: height }, (_, row) => pixels.slice(row * width, (row + 1) * width).join("")).join("\n");
}

export const ASCII_SCENES = ["STACK", "CODE", "TERMINAL", "DATABASE", "BRANCHES", "LAUNCH"] as const;

function pattern(index: number): string {
  const grid = Array.from({ length: ASCII_ROWS }, () => new Array<string>(ASCII_COLUMNS).fill(" "));
  const put = (x: number, y: number, c: string) => {
    x = Math.round(x); y = Math.round(y);
    if (x >= 0 && x < ASCII_COLUMNS && y >= 0 && y < ASCII_ROWS) grid[y][x] = c;
  };
  const text = (x: number, y: number, value: string) => [...value].forEach((c, i) => put(x + i, y, c));
  const line = (x: number, y: number, endX: number, endY: number, c?: string) => {
    const dx = endX - x, dy = endY - y;
    const steps = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)));
    const glyph = c ?? (dy === 0 ? "=" : dx === 0 ? "|" : dx * dy > 0 ? "\\" : "/");
    for (let i = 0; i <= steps; i++) put(x + dx * i / Math.max(1, steps), y + dy * i / Math.max(1, steps), glyph);
  };
  const box = (x: number, y: number, w: number, h: number) => {
    line(x, y, x + w, y); line(x, y + h, x + w, y + h);
    line(x, y, x, y + h); line(x + w, y, x + w, y + h);
    line(x + 1, y + 1, x + 1, y + h - 1); line(x + w - 1, y + 1, x + w - 1, y + h - 1);
    for (const [cx, cy] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]) put(cx, cy, "+");
  };
  const ellipse = (cx: number, cy: number, rx: number, ry: number) => {
    for (let i = 0; i < 240; i++) {
      const angle = i / 240 * Math.PI * 2;
      put(cx + Math.cos(angle) * rx, cy + Math.sin(angle) * ry, Math.abs(Math.sin(angle)) > .8 ? "=" : "#");
    }
  };
  if (index === 1 || index === 2) {
    box(18, 10, 86, 39); text(22, 13, "o  o  o"); text(78, 13, index === 1 ? "src / app.tsx" : "~/ stackpilot");
    line(19, 16, 103, 16);
    if (index === 1) {
      for (let stroke = -1; stroke <= 1; stroke++) {
        line(44 + stroke, 23, 34 + stroke, 31, "/"); line(34 + stroke, 31, 44 + stroke, 39, "\\");
        line(65 + stroke, 21, 56 + stroke, 41, "/");
        line(77 + stroke, 23, 87 + stroke, 31, "\\"); line(87 + stroke, 31, 77 + stroke, 39, "/");
      }
      text(25, 19, "01   export default"); text(25, 43, "02   { build(); test(); deploy(); }");
      text(25, 46, "03   // from source to live");
    } else {
      text(25, 22, "$ stackpilot deploy --production"); text(25, 27, "[+] STACK      resolved { web, api, db }");
      text(25, 31, "[+] BUILD      source -> artifact"); text(25, 35, "[+] TEST       checks passed");
      text(25, 40, "[#################################] 100%"); text(25, 45, "$ READY _");
    }
  } else if (index === 3) {
    for (const [layer, cy] of [14, 28, 42].entries()) {
      for (let x = -31; x <= 31; x++) {
        const curve = Math.sqrt(Math.max(0, 1 - (x / 31) ** 2)) * 4;
        for (let y = -Math.floor(curve); y <= Math.floor(curve); y++) {
          put(62 + x, cy + y, (x + y * 2) % 5 === 0 ? "+" : ":");
        }
        for (let y = Math.ceil(curve); y <= Math.floor(curve + 8); y++) {
          const density = x < -18 ? "#" : x < -8 ? "+" : x > 21 ? ":" : ".";
          put(62 + x, cy + y, (x + y) % 3 === 0 ? ":" : density);
        }
        put(62 + x, cy + curve + 8, "=");
      }
      ellipse(62, cy, 31, 4); line(31, cy, 31, cy + 8, "#"); line(93, cy, 93, cy + 8, "#");
      const titles = ["[01]  DATABASE / PRIMARY", "[02]  TABLES { KEY : VALUE }", "[03]  0101  ::  STORAGE"];
      text(46, cy + 6, " " + titles[layer] + " ");
      text(49, cy + 3, "[ = = ]   { 01 : 10 }");
    }
  } else if (index === 4) {
    line(35, 15, 35, 45); line(35, 27, 61, 27); line(61, 27, 61, 15);
    line(35, 35, 87, 35); line(87, 35, 87, 23);
    for (const [x, y] of [[35, 15], [35, 45], [61, 15], [87, 23]]) {
      box(x - 5, y - 2, 10, 4); text(x - 2, y, "<+>");
    }
    text(27, 8, "[ main ]"); text(54, 8, "[ preview ]"); text(80, 16, "release");
    text(47, 44, "o===o===o===o  [ HEAD ]"); text(48, 48, "git { commit -> deploy }");
  } else {
    for (let y = 10; y <= 38; y++) {
      const half = Math.min(12, (y - 10) * .8);
      for (let x = -Math.floor(half); x <= Math.floor(half); x++) put(62 + x, y, x < -7 ? "#" : x > 7 ? ":" : (x + y) % 3 === 0 ? "+" : ".");
    }
    line(62, 9, 49, 25, "/"); line(62, 9, 75, 25, "\\");
    line(49, 25, 49, 39, "#"); line(75, 25, 75, 39, "#"); line(49, 39, 75, 39, "=");
    ellipse(62, 25, 6, 4); text(58, 25, " [ + ] "); text(54, 34, "{ READY }");
    line(49, 31, 39, 41, "/"); line(39, 41, 49, 39, "="); line(75, 31, 85, 41, "\\"); line(75, 39, 85, 41, "=");
    for (let x = -6; x <= 6; x += 3) line(62 + x, 41, 62 + x * .5, 48, ":");
    text(16, 23, "[+] BUILD"); text(16, 27, "[+] VERIFY"); text(16, 31, "[+] RELEASE");
    text(84, 23, "0101 : ONLINE"); text(84, 27, "{ ALL SYSTEMS }"); text(84, 31, "[ GO FOR LAUNCH ]");
    text(45, 52, "[ SOURCE ====> PRODUCTION ]");
  }
  return grid.map(row => row.join("")).join("\n");
}

const PATTERNS = ["", ...Array.from({ length: 5 }, (_, i) => pattern(i + 1))];
export type AsciiGlyph = { x: number; y: number; glyph: string };

export function asciiGlyphs(frame: string): AsciiGlyph[] {
  return frame.split("\n").flatMap((row, y) => [...row].flatMap((glyph, x) => glyph === " " ? [] : [{ x, y, glyph }]));
}

export function renderAsciiScene(index: number, yaw: number, pitch: number): string {
  if (index === 0) return renderAsciiStack(yaw, pitch, .92);
  const cells = new Array<string>(ASCII_COLUMNS * ASCII_ROWS).fill(" ");
  const turn = (yaw - STACK_REST.yaw) * .3, tilt = (pitch - STACK_REST.pitch) * .5;
  for (const p of asciiGlyphs(PATTERNS[index % ASCII_SCENES.length])) {
    const x = p.x - ASCII_COLUMNS / 2, y = p.y - ASCII_ROWS / 2;
    const depth = 1 + (x * Math.sin(turn) + y * Math.sin(tilt) * 2) / 350;
    const col = Math.round(ASCII_COLUMNS / 2 + x * Math.cos(turn) / depth);
    const row = Math.round(ASCII_ROWS / 2 + (y * Math.cos(tilt) + x * Math.sin(turn) * .1) / depth);
    if (col >= 0 && col < ASCII_COLUMNS && row >= 0 && row < ASCII_ROWS) cells[row * ASCII_COLUMNS + col] = p.glyph;
  }
  return Array.from({ length: ASCII_ROWS }, (_, i) => cells.slice(i * ASCII_COLUMNS, (i + 1) * ASCII_COLUMNS).join("")).join("\n");
}

/** Move real text cells between silhouettes, with a small, deterministic stagger. */
export function morphAscii(from: AsciiGlyph[], to: AsciiGlyph[], progress: number): string {
  const cells = new Array<string>(ASCII_COLUMNS * ASCII_ROWS).fill(" ");
  const count = Math.max(from.length, to.length);
  for (let i = 0; i < count; i++) {
    const a = from[Math.floor(i * from.length / count)], b = to[Math.floor(i * to.length / count)];
    if (!a || !b) continue;
    const t = Math.min(1, Math.max(0, (progress - i / count * .12) / .88));
    const smooth = t * t * t * (t * (t * 6 - 15) + 10);
    const x = Math.round(a.x + (b.x - a.x) * smooth), y = Math.round(a.y + (b.y - a.y) * smooth);
    cells[y * ASCII_COLUMNS + x] = smooth < .5 ? a.glyph : b.glyph;
  }
  return Array.from({ length: ASCII_ROWS }, (_, i) => cells.slice(i * ASCII_COLUMNS, (i + 1) * ASCII_COLUMNS).join("")).join("\n");
}
