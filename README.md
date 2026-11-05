# Mesa de electrónica · SimReady

**Demo: <https://mesa-electronica-3d.vercel.app>**

Mesa de trabajo 3D en el navegador para practicar mediciones reales de **tensión, corriente, resistencia y potencia** con un multímetro digital y una fuente de laboratorio, sobre circuitos armados en un protoboard.

El entorno (mesa, lámpara, herramientas, taza, silla) usa assets **OpenUSD de [NVIDIA SimReady](https://huggingface.co/datasets/nvidia/simready-assets)** (CC-BY-4.0), convertidos a GLB. Los instrumentos y el protoboard están modelados a escala real y son interactivos.

## Cómo correrlo

```bash
pnpm install
pnpm dev          # http://localhost:5173
pnpm test         # tests de la física (MNA, instrumentos, térmica, fusibles)
pnpm build
```

Los GLB ya convertidos están en `public/models/`. Para regenerarlos o agregar otros assets:

```bash
python -m venv .venv
.venv/Scripts/python -m pip install usd-core pillow numpy   # (Linux/mac: .venv/bin/python)
pnpm assets:fetch     # baja de Hugging Face los assets de tools/assets.json (~550 MB a .cache/)
pnpm assets:convert   # USD -> GLB con texturas reducidas, en public/models/
```

`tools/usd_to_glb.py` compone el stage completo con `usd-core` (referencias, payloads, variantes e instancias), descarta las mallas de colisión y guía, pasa de Z-up a Y-up, lee los materiales `UsdPreviewSurface` (albedo / ORM / normal + `UsdTransform2d`) y hornea el tiling en las UV.

## Video showcase

`tools/record-showcase.mjs` graba un video de demo cuadro a cuadro (1920×1080, 60 fps, H.264) manejando la app con Playwright en modo `?capture`: el tiempo de la simulación avanza solo cuando el grabador pide un cuadro, así el resultado es fluido aunque cada cuadro tarde más en renderizarse. Necesita Chrome instalado y `ffmpeg` en el PATH.

```bash
pnpm dev                     # en otra terminal
pnpm record                  # -> media/showcase.mp4
pnpm record:preview          # cuadros sueltos en media/preview/ para revisar encuadres
node tools/record-showcase.mjs --url tu-dominio.app   # texto de la placa final
```

## Qué se simula (y con qué precisión)

| Parte | Modelo |
|---|---|
| Circuito | Análisis nodal modificado (MNA) exacto, con gmin de 1 pS como SPICE. Cables, puentes y puntas tienen su resistencia (30 / 15 / 50 mΩ). |
| Resistores | Valor real dentro de la tolerancia (±5 % carbón, ±1 % metal film), coeficiente térmico (carbón ≈ −400 ppm/°C, metal ≈ +35 ppm/°C), modelo térmico de 1.er orden (~150 °C a potencia nominal), humo arriba de 230 °C, se quema (abierto) a 340 °C. Código de colores IEC 60062. |
| Fuente 0–30 V / 0–3 A | Regulación CV/CC con límite de corriente, R de salida 2 mΩ, displays con su propio error ±(0,5 % + 2 díg.). Al girar una perilla muestra el valor programado. |
| Multímetro 6000 cuentas | V⎓ con **10 MΩ** de entrada (efecto de carga real), Ω ratiométrico (incluye los 0,1 Ω de las puntas, de ahí que exista REL), mA con shunt de 1,8 Ω y fusible de 440 mA, 10A con 0,03 Ω y fusible de 11 A. Autorango con histéresis, ~3 lecturas/s, calibración fija por rango y ruido de ±1 cuenta. |
| Errores reales | Medir con la punta en la borna de corriente es un corto (y quema el fusible si la fuente lo permite), alerta **LEAd**, V~ sobre continua da ≈ 0, Ω con el circuito energizado da lecturas inválidas, Ω en circuito incluye los caminos en paralelo. |

La potencia no la mide un multímetro: se anota V e I en el **cuaderno de mediciones** y la calculadora hace P = V·I, con la incertidumbre que suman los dos instrumentos.

## Circuitos

Ley de Ohm, serie (divisor), paralelo, mixto y **efecto de carga del voltímetro** (divisor de 4,7 MΩ: en teoría 5,00 V, el instrumento lee ≈ 4,05 V). Para medir corriente se quita un **puente** y el multímetro se pone en serie, como en un protoboard real.

## Controles

- Cámara: arrastrar para rotar, botón derecho para desplazar, rueda para zoom. Vistas rápidas: teclas `1`–`4`.
- Llave del multímetro: clic izquierdo/derecho o rueda. Bornas: clic en la borna (o en la ficha roja).
- Perillas de la fuente: rueda o arrastre (Shift ×10, Alt ×0,1). `O` enciende/apaga la salida.
- Puntas: clic en la punta (o teclas `R` / `N`) y luego en un agujero, una pata o un borne. `Esc` cancela.
- Puentes: clic para quitar/poner. `Espacio` anota la lectura en el cuaderno.

## Estructura

```
src/sim/      física pura y testeada (mna, resistor, psu, dmm, circuits, bench)
src/scene/    three.js: mundo, protoboard, multímetro, fuente, puntas/cables, picking
src/ui/       panel lateral
tools/        descarga y conversión de assets SimReady
```

## Licencia

Código: [MIT](LICENSE). Assets 3D: derivados de [NVIDIA SimReady Assets](https://huggingface.co/datasets/nvidia/simready-assets), © NVIDIA, [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/); detalle de los cambios en [ASSETS-LICENSE.md](ASSETS-LICENSE.md).
