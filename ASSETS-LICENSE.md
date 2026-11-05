# Licencia de los assets 3D

Los modelos en `public/models/` son obras derivadas de **NVIDIA SimReady Assets**
(<https://huggingface.co/datasets/nvidia/simready-assets>), © NVIDIA Corporation,
publicados bajo **Creative Commons Attribution 4.0 International (CC-BY-4.0)**:
<https://creativecommons.org/licenses/by/4.0/>.

| Archivo | Asset original |
|---|---|
| `furniture_workbench_standard_e01.glb` | `furniture_workbench_standard_e01` |
| `lamp_table_bedside_a01.glb` | `lamp_table_bedside_a01` |
| `handTool_pliers_long_nose_a01.glb` | `handTool_pliers_long_nose_a01` |
| `handTool_pliers_diagonal_cutting_a01.glb` | `handTool_pliers_diagonal_cutting_a01` |
| `handTool_screwdriver_slotted_4mm_a01.glb` | `handTool_screwdriver_slotted_4mm_a01` |
| `dishware_mug_coffee_a01.glb` | `dishware_mug_coffee_a01` |
| `chair_office_amf_black_a01.glb` | `chair_office_amf_black_a01` |

**Cambios realizados** (con `tools/usd_to_glb.py`):

- Conversión de OpenUSD a glTF binario (`.glb`), con el stage compuesto y aplanado a una sola malla por material.
- Se quitaron los datos de física, colisión y agarre, y los materiales MDL (se usa la red `UsdPreviewSurface`).
- Cambio de ejes (Z-up → Y-up) y tiling de texturas horneado en las coordenadas UV.
- Texturas reducidas (de hasta 8K a 512–1024 px) y recodificadas en JPEG.

NVIDIA no avala este proyecto. El código del proyecto se distribuye por separado bajo licencia MIT (ver `LICENSE`).

---

# 3D asset license (English)

The models in `public/models/` are adapted from **NVIDIA SimReady Assets**
(<https://huggingface.co/datasets/nvidia/simready-assets>), © NVIDIA Corporation, licensed under
**CC-BY-4.0**. Changes: converted from OpenUSD to binary glTF; physics, collision, grasp and MDL data
removed; Z-up to Y-up; texture tiling baked into UVs; textures downscaled to 512–1024 px and re-encoded as JPEG.
This project is not endorsed by NVIDIA.
