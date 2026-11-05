/** Dibujo de dígitos de 7 segmentos en canvas 2D (LCD del multímetro y LEDs de la fuente). */

// segmentos: a b c d e f g
const MAP: Record<string, string> = {
  "0": "abcdef",
  "1": "bc",
  "2": "abdeg",
  "3": "abcdg",
  "4": "bcfg",
  "5": "acdfg",
  "6": "acdefg",
  "7": "abc",
  "8": "abcdefg",
  "9": "abcdfg",
  "-": "g",
  O: "abcdef",
  L: "def",
  E: "adefg",
  A: "abcefg",
  d: "bcdeg",
  P: "abefg",
  F: "aefg",
  n: "ceg",
  o: "cdeg",
  r: "eg",
  " ": "",
};

export interface SegStyle {
  on: string;
  off: string | null;
  /** inclinación (shear) típica de los displays de 7 segmentos */
  slant?: number;
  thickness?: number;
}

function segPath(ctx: CanvasRenderingContext2D, seg: string, x: number, y: number, w: number, h: number, t: number, slant: number) {
  const hh = h / 2;
  const sk = (yy: number) => (h - (yy - y)) * slant; // desplazamiento horizontal por shear
  const g = t * 0.18; // separación entre segmentos
  const hor = (yy: number) => {
    const x0 = x + g + t / 2;
    const x1 = x + w - g - t / 2;
    ctx.moveTo(x0 + sk(yy), yy);
    ctx.lineTo(x0 + t / 2 + sk(yy - t / 2), yy - t / 2);
    ctx.lineTo(x1 - t / 2 + sk(yy - t / 2), yy - t / 2);
    ctx.lineTo(x1 + sk(yy), yy);
    ctx.lineTo(x1 - t / 2 + sk(yy + t / 2), yy + t / 2);
    ctx.lineTo(x0 + t / 2 + sk(yy + t / 2), yy + t / 2);
    ctx.closePath();
  };
  const ver = (xx: number, y0: number, y1: number) => {
    y0 += g + t / 2;
    y1 -= g + t / 2;
    ctx.moveTo(xx + sk(y0), y0);
    ctx.lineTo(xx + t / 2 + sk(y0 + t / 2), y0 + t / 2);
    ctx.lineTo(xx + t / 2 + sk(y1 - t / 2), y1 - t / 2);
    ctx.lineTo(xx + sk(y1), y1);
    ctx.lineTo(xx - t / 2 + sk(y1 - t / 2), y1 - t / 2);
    ctx.lineTo(xx - t / 2 + sk(y0 + t / 2), y0 + t / 2);
    ctx.closePath();
  };
  const L = x + t / 2;
  const R = x + w - t / 2;
  switch (seg) {
    case "a":
      return hor(y + t / 2);
    case "g":
      return hor(y + hh);
    case "d":
      return hor(y + h - t / 2);
    case "f":
      return ver(L, y + t / 2, y + hh);
    case "b":
      return ver(R, y + t / 2, y + hh);
    case "e":
      return ver(L, y + hh, y + h - t / 2);
    case "c":
      return ver(R, y + hh, y + h - t / 2);
  }
}

/**
 * Dibuja `text` alineado a la derecha en `cells` celdas de dígito. Los puntos decimales se
 * dibujan en la celda anterior (como en un display real).
 */
export function drawSevenSeg(
  ctx: CanvasRenderingContext2D,
  text: string,
  cells: number,
  x: number,
  y: number,
  digitW: number,
  digitH: number,
  gap: number,
  style: SegStyle,
): void {
  const slant = style.slant ?? 0.08;
  const t = style.thickness ?? digitW * 0.17;
  const chars: { c: string; dp: boolean }[] = [];
  for (const ch of text) {
    if (ch === "." && chars.length) chars[chars.length - 1].dp = true;
    else chars.push({ c: ch, dp: false });
  }
  while (chars.length < cells) chars.unshift({ c: " ", dp: false });
  const visible = chars.slice(-cells);
  visible.forEach((cell, i) => {
    const cx = x + i * (digitW + gap);
    const on = MAP[cell.c] ?? "";
    for (const seg of "abcdefg") {
      const lit = on.includes(seg);
      if (!lit && !style.off) continue;
      ctx.beginPath();
      segPath(ctx, seg, cx, y, digitW, digitH, t, slant);
      ctx.fillStyle = lit ? style.on : style.off!;
      ctx.fill();
    }
    // punto decimal
    if (cell.dp || style.off) {
      ctx.beginPath();
      ctx.arc(cx + digitW + gap * 0.5, y + digitH - t * 0.5, t * 0.62, 0, Math.PI * 2);
      ctx.fillStyle = cell.dp ? style.on : style.off!;
      ctx.fill();
    }
  });
}
