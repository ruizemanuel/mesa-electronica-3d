# Mesa de electrónica · SimReady

**Demo: <https://mesa-electronica-3d.vercel.app>**

Mesa de trabajo 3D en el navegador para practicar mediciones reales de **tensión, corriente, resistencia y potencia** con un multímetro digital y una fuente de laboratorio, sobre circuitos armados en un protoboard: resistores, **diodos y LED**.

El entorno (mesa, lámpara, herramientas, taza, silla) usa assets **OpenUSD de [NVIDIA SimReady](https://huggingface.co/datasets/nvidia/simready-assets)** (CC-BY-4.0), convertidos a GLB. Los instrumentos y el protoboard están modelados a escala real y son interactivos.

## Cómo correrlo

```bash
pnpm install
pnpm dev          # http://localhost:5173
pnpm test         # tests de la física (MNA, diodos, instrumentos, térmica, fusibles)
pnpm build
```

Los GLB ya convertidos y comprimidos están en `public/models/` (5,7 MB en total). Para regenerarlos o agregar otros assets:

```bash
python -m venv .venv
.venv/Scripts/python -m pip install usd-core pillow numpy   # (Linux/mac: .venv/bin/python)
pnpm assets:fetch     # baja de Hugging Face los assets de tools/assets.json (~550 MB a .cache/)
pnpm assets:convert   # USD -> GLB crudo con texturas reducidas, en .cache/glb/ (~26 MB)
pnpm assets:optimize  # meshopt + texturas WebP, en public/models/ (~5,7 MB + versión liviana de la mesa)
```

La compresión usa [glTF Transform](https://gltf-transform.dev) y three.js la decodifica con `MeshoptDecoder`, sin archivos wasm aparte. La geometría de escritorio no se simplifica. Para celulares se genera además `furniture_workbench_standard_e01.lite.glb`: la chapa perforada pasa de 371 mil a 73 mil triángulos, con normales planas recalculadas (el USD trae los bordes de los agujeros suavizados y, sin eso, la simplificación deja un sombreado en estrella).

## Celulares y rendimiento

- **Calidad según el dispositivo:** las pantallas táctiles usan la mesa liviana, sombras de 2048 px y resolución de hasta 1,5×. Se puede forzar con `?calidad=alta` o `?calidad=baja`.
- **Resolución adaptativa:** mide los FPS y baja o sube la densidad de píxeles de a 0,25 para mantener la fluidez.
- **Sombras a demanda:** el mapa de sombras solo se recalcula cuando se mueve algo que proyecta sombra (puntas, perillas, cables), no al mover la cámara.
- **Táctil:** para apoyar una punta se apoya el dedo y se arrastra; la mira va 64 px por encima del dedo y la punta se apoya al soltar. Las perillas se giran arrastrando y los textos de ayuda cambian a gestos táctiles.

Medido en un Moto G32 (Adreno 610): de 13 FPS a unos 30–35 en la vista general y 55 en las vistas cercanas.

`tools/usd_to_glb.py` compone el stage completo con `usd-core` (referencias, payloads, variantes e instancias), descarta las mallas de colisión y guía, pasa de Z-up a Y-up, lee los materiales `UsdPreviewSurface` (albedo / ORM / normal + `UsdTransform2d`) y hornea el tiling en las UV.

## Video showcase

`tools/record-showcase.mjs` graba un video de demo cuadro a cuadro (1920×1080, 60 fps, H.264) manejando la app con Playwright en modo `?capture`: el tiempo de la simulación avanza solo cuando el grabador pide un cuadro, así el resultado es fluido aunque cada cuadro tarde más en renderizarse. Necesita Chrome instalado y `ffmpeg` en el PATH.

```bash
pnpm dev                     # en otra terminal
pnpm record                  # -> media/showcase.mp4
pnpm record:preview          # cuadros sueltos en media/preview/ para revisar encuadres
pnpm record:led              # -> media/led.mp4: clip de 11 s del LED que se quema sin resistencia
node tools/record-showcase.mjs --url tu-dominio.app   # texto de la placa final
```

La imagen de vista previa del link (`public/og.jpg`, 1200×630) también sale de la escena real: con `pnpm dev` corriendo, `node tools/og-image.mjs` la regenera.

## Qué se simula (y con qué precisión)

| Parte | Modelo |
|---|---|
| Circuito | Análisis nodal modificado (MNA) exacto, con gmin de 1 pS como SPICE. Cables, puentes y puntas tienen su resistencia (30 / 15 / 50 mΩ). Con diodos, el sistema no es lineal: se resuelve con **Newton-Raphson**, linealizando cada juntura en cada iteración y limitando el paso de tensión como SPICE (`pnjlim`). Cada paso arranca desde la solución anterior, así converge en 1 o 2 iteraciones. |
| Resistores | Valor real dentro de la tolerancia (±5 % carbón, ±1 % metal film), coeficiente térmico (carbón ≈ −400 ppm/°C, metal ≈ +35 ppm/°C), modelo térmico de 1.er orden (~150 °C a potencia nominal), humo arriba de 230 °C, se quema (abierto) a 340 °C. Código de colores IEC 60062. |
| Diodos | Modelo de Shockley `I = Is·(e^(V/nVt) − 1)` con resistencia serie. **1N4007** con el modelo SPICE clásico (0,55 V a 1 mA, 0,91 V a 1 A). Cada muestra tiene su propia Vf dentro de la dispersión del lote, la Vf baja ≈ 2 mV/°C al calentarse y hay modelo térmico de 1.er orden (Rth 50 °C/W). |
| LED de 5 mm | Rojo (Vf ≈ 1,8 V), verde (2,1 V), azul y blanco (≈ 3 V) a 20 mA, máximo 30 mA. El brillo sigue a la corriente y cae con la temperatura de juntura. Rth ≈ 350 °C/W: a 20 mA queda tibio; sin resistencia, con la fuente limitada a 0,5 A, la juntura pasa los 170 °C en medio segundo y se abre. Con la prueba de diodos (1 mA) se prende apenas, como uno real. |
| Fuente 0–30 V / 0–3 A | Regulación CV/CC con límite de corriente, R de salida 2 mΩ, displays con su propio error ±(0,5 % + 2 díg.). Al girar una perilla muestra el valor programado. |
| Multímetro 6000 cuentas | V⎓ con **10 MΩ** de entrada (efecto de carga real), Ω ratiométrico (incluye los 0,1 Ω de las puntas, de ahí que exista REL), **prueba de diodos** con fuente de 1 mA y tensión a circuito abierto limitada a ≈ 3,2 V (muestra la caída hasta 3,000 V y OL en inversa), mA con shunt de 1,8 Ω y fusible de 440 mA, 10A con 0,03 Ω y fusible de 11 A. Como en muchos multímetros reales, Ω, ▶| y ·))) comparten una posición de la llave y se alternan con **SELECT**. Autorango con histéresis, ~3 lecturas/s, calibración fija por rango y ruido de ±1 cuenta. |
| Errores reales | Medir con la punta en la borna de corriente es un corto (y quema el fusible si la fuente lo permite), alerta **LEAd**, V~ sobre continua da ≈ 0, Ω con el circuito energizado da lecturas inválidas, Ω en circuito incluye los caminos en paralelo. |

La potencia no la mide un multímetro: se anota V e I en el **cuaderno de mediciones** y la calculadora hace P = V·I, con la incertidumbre que suman los dos instrumentos.

## Circuitos

Ley de Ohm, serie (divisor), paralelo, mixto y **efecto de carga del voltímetro** (divisor de 4,7 MΩ: en teoría 5,00 V, el instrumento lee ≈ 4,05 V). Para medir corriente se quita un **puente** y el multímetro se pone en serie, como en un protoboard real.

Con diodos:

- **LED con resistencia limitadora**: 330 Ω y un LED rojo a 5 V (≈ 9 mA). El puente J3 cortocircuita la resistencia: con 0,5 A de límite el LED se quema; con 25 mA la fuente entra en CC y sobrevive. El color se cambia en el panel (misma R, distinta corriente).
- **Diodo en directa e inversa**: 1N4007 con 1 kΩ. Se puede **dar vuelta** desde el panel; con la prueba de diodos se encuentra el cátodo.
- **Curva I-V**: LED (o 1N4007) con 100 Ω ±1 %. Se mide Vd y V_R a distintas tensiones de la fuente, se anotan en el cuaderno y la tarjeta **Curva I-V** arma el gráfico (I = V_R / R, o la corriente medida en serie), con el modelo nominal superpuesto. Compara hasta tres componentes.

En 3D, el LED de 5 mm tiene la pata del ánodo más larga (el sobrante queda como codo al calzarla en el protoboard), el borde plano del lado del cátodo y el marco interno visible a través del epoxi; encendido, el epoxi emite, aparece un halo y una luz ilumina la placa. El 1N4007 tiene la banda del cátodo y la leyenda impresa.

## Controles

- Cámara: arrastrar para rotar, botón derecho para desplazar, rueda para zoom. Vistas rápidas: teclas `1`–`4`.
- Llave del multímetro: clic izquierdo/derecho o rueda. **SELECT** alterna Ω → ▶| → ·))) en la misma posición. Bornas: clic en la borna (o en la ficha roja).
- Perillas de la fuente: rueda o arrastre (Shift ×10, Alt ×0,1). `O` enciende/apaga la salida.
- Puntas: clic en la punta (o teclas `R` / `N`) y luego en un agujero, una pata o un borne. `Esc` cancela.
- Puentes: clic para quitar/poner. `Espacio` anota la lectura en el cuaderno.

## Estructura

```
src/sim/      física pura y testeada (mna, resistor, diode, psu, dmm, circuits, bench)
src/scene/    three.js: mundo, protoboard, LED y diodos, multímetro, fuente, puntas/cables, picking
src/ui/       panel lateral y curva I-V
tools/        descarga y conversión de assets SimReady
```

## Licencia

Código: [MIT](LICENSE). Assets 3D: derivados de [NVIDIA SimReady Assets](https://huggingface.co/datasets/nvidia/simready-assets), © NVIDIA, [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/); detalle de los cambios en [ASSETS-LICENSE.md](ASSETS-LICENSE.md).
