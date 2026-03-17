# ComfyVoxelizer

A vanilla JavaScript web application that orchestrates a local ComfyUI instance to execute an end-to-end pipeline: **Text-to-Image → Image-to-3D Mesh → Client-side Voxelization → Three.js Voxel Render**.

Enter a text description, and the app generates an AI image, converts it to a 3D mesh, voxelizes it client-side, and renders interactive voxel art in the browser.

## Features

- **Text-to-Image Generation** — Uses FLUX or SDXL checkpoints via ComfyUI
- **Image-to-3D Mesh** — Supports TRELLIS 2 and Hunyuan3D 2.1 models
- **Client-side Voxelization** — Ray-casting algorithm runs in a Web Worker for non-blocking performance
- **Interactive 3D Viewer** — Three.js InstancedMesh renderer with OrbitControls
- **Real-time Progress** — WebSocket-based progress tracking for all pipeline stages
- **Adjustable Resolution** — Voxel grid resolution slider (16–128) with live re-voxelization
- **Export** — MagicaVoxel .vox and JSON export formats
- **Dark Theme** — Clean creative-tool aesthetic

## Prerequisites

### ComfyUI Server

A locally running [ComfyUI](https://github.com/comfyanonymous/ComfyUI) instance is required (default: `http://127.0.0.1:8188`).

If serving the app from a different origin than ComfyUI, launch ComfyUI with CORS enabled:

```bash
python main.py --enable-cors-header
```

### Required Models

**Text-to-Image** (at least one):
- FLUX checkpoint (`flux1-dev.safetensors`) in `ComfyUI/models/checkpoints/`
- SDXL checkpoint (`sd_xl_base_1.0.safetensors`) in `ComfyUI/models/checkpoints/`

**Image-to-3D** (at least one):

| Model | Custom Nodes | Repository |
|-------|-------------|------------|
| TRELLIS 2 | ComfyUI-TRELLIS2 | [PozzettiAndrea/ComfyUI-TRELLIS2](https://github.com/PozzettiAndrea/ComfyUI-TRELLIS2) |
| Hunyuan3D 2.1 | ComfyUI-Hunyuan3DWrapper | [kijai/ComfyUI-Hunyuan3DWrapper](https://github.com/kijai/ComfyUI-Hunyuan3DWrapper) |

### Hardware

- **GPU**: NVIDIA GPU with 8+ GB VRAM (12+ GB recommended for TRELLIS 2)
- **RAM**: 16 GB minimum
- **Browser**: Modern browser with WebGL support (Chrome, Firefox, Edge)

## Setup

1. **Install ComfyUI** and required custom nodes (see Prerequisites above)
2. **Start ComfyUI**:
   ```bash
   cd ComfyUI
   python main.py --enable-cors-header
   ```
3. **Serve the app** using any static file server:
   ```bash
   # Python
   python -m http.server 3000

   # Node.js
   npx serve .

   # Or simply open index.html in the browser if ComfyUI is on the same origin
   ```
4. **Open** `http://localhost:3000` in your browser

## Usage

1. Enter the ComfyUI server URL (default: `http://127.0.0.1:8188`) and click **Connect**
2. Verify the green connection indicator
3. Select your **Text-to-Image model** (FLUX or SDXL) and **Image-to-3D model** (TRELLIS 2 or Hunyuan3D 2.1)
4. Type a text prompt describing your desired 3D object
5. Click **Generate** (or press `Ctrl+Enter`)
6. Watch the 4-stage progress: Image Generation → 3D Mesh → Voxelization → Rendering
7. Interact with the voxel model using mouse controls (orbit, zoom, pan)
8. Adjust the **resolution slider** to re-voxelize at different detail levels
9. **Export** as `.vox` (MagicaVoxel) or `.json`

### Prompt Tips

- Describe a **single, isolated object** on a white/neutral background
- Be specific: *"a medieval wooden treasure chest with iron bands"*
- Mention viewing angle: *"front view"*, *"isometric view"*
- Add material descriptors: *"matte ceramic"*, *"polished metal"*
- Avoid complex scenes, multiple objects, or environments

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Browser (Frontend)                │
│                                                     │
│  index.html ──> app.js (state machine)              │
│                   │                                 │
│      ┌────────────┼────────────┬──────────┐         │
│      ▼            ▼            ▼          ▼         │
│  comfyui-    workflow-    voxelizer.js  voxel-      │
│  client.js   builder.js      │         renderer.js  │
│  (REST+WS)   (templates)     ▼         (Three.js)   │
│                          voxelizer-                  │
│                          worker.js     exporter.js   │
│                          (Web Worker)  (.vox/.json)  │
└────────────────┬────────────────────────────────────┘
                 │ REST + WebSocket
                 ▼
┌─────────────────────────────────────────────────────┐
│              ComfyUI Server (Backend)               │
│                                                     │
│  POST /prompt ──> Queue workflow                    │
│  GET /history/{id} ──> Get results                  │
│  GET /view?filename= ──> Retrieve files             │
│  WS /ws?clientId= ──> Real-time progress            │
└─────────────────────────────────────────────────────┘
```

### File Structure

```
ComfyVoxelizer/
├── index.html                  # Entry point
├── css/
│   └── styles.css              # Dark theme styles
├── js/
│   ├── config.js               # Configuration defaults
│   ├── app.js                  # Main app, state machine
│   ├── comfyui-client.js       # REST + WebSocket client
│   ├── workflow-builder.js     # Workflow template loader
│   ├── voxelizer.js            # Main-thread geometry extraction
│   ├── voxelizer-worker.js     # Web Worker ray-casting voxelizer
│   ├── voxel-renderer.js       # Three.js InstancedMesh renderer
│   └── exporter.js             # .vox and JSON export
├── workflows/
│   ├── text-to-image-flux.json
│   ├── text-to-image-sdxl.json
│   ├── image-to-3d-trellis2.json
│   └── image-to-3d-hunyuan3d.json
└── README.md
```

### State Machine

```
IDLE → GENERATING_IMAGE → GENERATING_MESH → VOXELIZING → RENDERING → COMPLETE
  ↑                                                                      │
  └──────────────────────── (on retry) ←── ERROR ←── (any failure) ──────┘
```

### Voxelization Algorithm

1. Parse GLB via Three.js GLTFLoader
2. Extract and merge mesh geometries
3. Compute axis-aligned bounding box (AABB)
4. Divide into N×N×N uniform grid (default N=64)
5. For each column, cast a ray along Y-axis
6. Intersect with all triangles, sort by distance
7. Even-odd rule determines solid voxels
8. Sample color from nearest triangle (vertex color or UV texture)
9. Store in `Uint8Array(N³)` occupancy + `Uint8Array(N³×3)` RGB

### Export Formats

- **MagicaVoxel .vox**: Binary format with VOX header (v150), MAIN/SIZE/XYZI/RGBA chunks, 256-color palette
- **JSON**: `{ resolution: N, voxels: [[x, y, z, r, g, b], ...] }`

## Configuration

Edit `js/config.js` to customize defaults:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `comfyuiUrl` | `http://127.0.0.1:8188` | ComfyUI server URL |
| `defaultResolution` | `64` | Default voxel grid resolution |
| `maxResolution` | `128` | Maximum voxel resolution |
| `samplerSteps` | `20` | Diffusion sampling steps |
| `cfg` | `7.0` | Classifier-free guidance scale |
| `negativePrompt` | `"blurry, low quality..."` | Default negative prompt |

## License

MIT
