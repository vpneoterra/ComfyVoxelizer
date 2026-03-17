/**
 * Exporter Module
 * Exports voxel data in MagicaVoxel .vox and JSON formats.
 */

export class Exporter {
  /**
   * Export voxel data as MagicaVoxel .vox format.
   * @param {Uint8Array} voxels - N³ occupancy grid
   * @param {Uint8Array} colorsRGB - N³×3 color array
   * @param {number} resolution - Grid resolution
   * @returns {Blob} .vox file blob
   */
  static exportVox(voxels, colorsRGB, resolution) {
    // Collect solid voxels
    const solidVoxels = [];
    for (let iz = 0; iz < resolution; iz++) {
      for (let iy = 0; iy < resolution; iy++) {
        for (let ix = 0; ix < resolution; ix++) {
          const idx = ix + iy * resolution + iz * resolution * resolution;
          if (voxels[idx]) {
            solidVoxels.push({
              x: ix, y: iz, z: iy, // .vox uses different axis convention (Y-up → Z-up)
              r: colorsRGB[idx * 3],
              g: colorsRGB[idx * 3 + 1],
              b: colorsRGB[idx * 3 + 2],
            });
          }
        }
      }
    }

    // Build 256-color palette from voxel colors
    const { palette, colorToIndex } = buildPalette(solidVoxels);

    // Calculate chunk sizes
    const numVoxels = solidVoxels.length;
    const xyziDataSize = 4 + numVoxels * 4; // numVoxels(4) + voxels(N*4)
    const rgbaDataSize = 256 * 4; // 256 colors × 4 bytes
    const sizeDataSize = 12; // 3 ints × 4 bytes

    const sizeChunkSize = 12 + sizeDataSize; // id(4) + contentSize(4) + childSize(4) + data
    const xyziChunkSize = 12 + xyziDataSize;
    const rgbaChunkSize = 12 + rgbaDataSize;
    const mainChildSize = sizeChunkSize + xyziChunkSize + rgbaChunkSize;
    const mainChunkSize = 12 + mainChildSize; // MAIN header + children

    const totalSize = 8 + mainChunkSize; // VOX header(4) + version(4) + MAIN
    const buffer = new ArrayBuffer(totalSize);
    const view = new DataView(buffer);
    let offset = 0;

    // VOX header
    writeString(view, offset, 'VOX '); offset += 4;
    view.setInt32(offset, 150, true); offset += 4; // Version 150

    // MAIN chunk
    writeString(view, offset, 'MAIN'); offset += 4;
    view.setInt32(offset, 0, true); offset += 4; // Content size (0 for MAIN)
    view.setInt32(offset, mainChildSize, true); offset += 4; // Child size

    // SIZE chunk
    writeString(view, offset, 'SIZE'); offset += 4;
    view.setInt32(offset, sizeDataSize, true); offset += 4;
    view.setInt32(offset, 0, true); offset += 4; // No children
    // Clamp resolution to max 256 for .vox format
    const voxRes = Math.min(resolution, 256);
    view.setInt32(offset, voxRes, true); offset += 4; // X
    view.setInt32(offset, voxRes, true); offset += 4; // Y
    view.setInt32(offset, voxRes, true); offset += 4; // Z

    // XYZI chunk
    writeString(view, offset, 'XYZI'); offset += 4;
    view.setInt32(offset, xyziDataSize, true); offset += 4;
    view.setInt32(offset, 0, true); offset += 4; // No children
    view.setInt32(offset, numVoxels, true); offset += 4;

    for (const voxel of solidVoxels) {
      const colorKey = `${voxel.r},${voxel.g},${voxel.b}`;
      const paletteIdx = colorToIndex.get(colorKey) || 1;
      view.setUint8(offset, voxel.x); offset += 1;
      view.setUint8(offset, voxel.y); offset += 1;
      view.setUint8(offset, voxel.z); offset += 1;
      view.setUint8(offset, paletteIdx); offset += 1;
    }

    // RGBA chunk (palette)
    writeString(view, offset, 'RGBA'); offset += 4;
    view.setInt32(offset, rgbaDataSize, true); offset += 4;
    view.setInt32(offset, 0, true); offset += 4; // No children

    for (let i = 0; i < 256; i++) {
      if (i < palette.length) {
        view.setUint8(offset, palette[i].r); offset += 1;
        view.setUint8(offset, palette[i].g); offset += 1;
        view.setUint8(offset, palette[i].b); offset += 1;
        view.setUint8(offset, 255); offset += 1; // Alpha
      } else {
        view.setUint8(offset, 0); offset += 1;
        view.setUint8(offset, 0); offset += 1;
        view.setUint8(offset, 0); offset += 1;
        view.setUint8(offset, 255); offset += 1;
      }
    }

    return new Blob([buffer], { type: 'application/octet-stream' });
  }

  /**
   * Export voxel data as JSON.
   * @param {Uint8Array} voxels - N³ occupancy grid
   * @param {Uint8Array} colorsRGB - N³×3 color array
   * @param {number} resolution - Grid resolution
   * @returns {Blob} JSON file blob
   */
  static exportJSON(voxels, colorsRGB, resolution) {
    const voxelList = [];

    for (let iz = 0; iz < resolution; iz++) {
      for (let iy = 0; iy < resolution; iy++) {
        for (let ix = 0; ix < resolution; ix++) {
          const idx = ix + iy * resolution + iz * resolution * resolution;
          if (voxels[idx]) {
            voxelList.push([
              ix, iy, iz,
              colorsRGB[idx * 3],
              colorsRGB[idx * 3 + 1],
              colorsRGB[idx * 3 + 2],
            ]);
          }
        }
      }
    }

    const data = {
      resolution,
      voxels: voxelList,
    };

    const jsonStr = JSON.stringify(data);
    return new Blob([jsonStr], { type: 'application/json' });
  }

  /**
   * Trigger a file download from a Blob.
   */
  static download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}

/**
 * Build a 256-color palette from voxel colors using median-cut-like quantization.
 */
function buildPalette(voxels) {
  // Collect unique colors
  const colorMap = new Map();
  for (const v of voxels) {
    const key = `${v.r},${v.g},${v.b}`;
    if (!colorMap.has(key)) {
      colorMap.set(key, { r: v.r, g: v.g, b: v.b, count: 0 });
    }
    colorMap.get(key).count++;
  }

  let uniqueColors = Array.from(colorMap.values());

  // If 256 or fewer unique colors, use them directly
  if (uniqueColors.length <= 255) {
    const palette = uniqueColors.map(c => ({ r: c.r, g: c.g, b: c.b }));
    const colorToIndex = new Map();
    for (let i = 0; i < palette.length; i++) {
      colorToIndex.set(`${palette[i].r},${palette[i].g},${palette[i].b}`, i + 1); // .vox palette is 1-indexed
    }
    return { palette, colorToIndex };
  }

  // Simple quantization: sort by frequency and keep top 255 colors,
  // then map remaining to nearest palette entry
  uniqueColors.sort((a, b) => b.count - a.count);
  const palette = uniqueColors.slice(0, 255).map(c => ({ r: c.r, g: c.g, b: c.b }));

  const colorToIndex = new Map();
  for (let i = 0; i < palette.length; i++) {
    colorToIndex.set(`${palette[i].r},${palette[i].g},${palette[i].b}`, i + 1);
  }

  // Map remaining colors to nearest palette entry
  for (const c of uniqueColors.slice(255)) {
    const key = `${c.r},${c.g},${c.b}`;
    let bestIdx = 1;
    let bestDist = Infinity;
    for (let i = 0; i < palette.length; i++) {
      const dr = c.r - palette[i].r;
      const dg = c.g - palette[i].g;
      const db = c.b - palette[i].b;
      const dist = dr * dr + dg * dg + db * db;
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i + 1;
      }
    }
    colorToIndex.set(key, bestIdx);
  }

  return { palette, colorToIndex };
}

/**
 * Write a 4-character string into a DataView.
 */
function writeString(view, offset, str) {
  for (let i = 0; i < 4; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
