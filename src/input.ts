/** Pantalla táctil sin mouse (celulares, tablets): cambia textos de ayuda y la forma de apuntar. */
export const IS_TOUCH = typeof matchMedia === "function" && matchMedia("(hover: none) and (pointer: coarse)").matches;

/** Verbo para las ayudas: "Clic" con mouse, "Tocá" en pantallas táctiles. */
export const TAP = IS_TOUCH ? "Tocá" : "Clic";
