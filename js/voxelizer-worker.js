/**
 * Voxelizer Web Worker
 * Implements ray-casting voxelization algorithm per spec Section 4.2.
 * Runs off the main thread for non-blocking operation.
 */

self.onmessage = function (e) {
  const { type, data } = e.data;
  if (type === 'voxelize') {
    try {
      const result = voxelize(data);
      self.postMessage(
        { type: 'result', data: result },
        [result.voxels.buffer, result.colorsRGB.buffer]
      );
    } catch (err) {
      self.postMessage({ type: 'error', data: { message: err.message } });
    }
  }
};

/**
 * Main voxelization function.
 */
function voxelize(data) {
  const { positions, indices, resolution, colors, uvs, textureData, textureWidth, textureHeight } = data;

  // Build triangle list
  const triangleCount = indices.length / 3;
  const triangles = new Float32Array(triangleCount * 9); // 3 vertices × 3 coords

  for (let i = 0; i < triangleCount; i++) {
    const i0 = indices[i * 3] * 3;
    const i1 = indices[i * 3 + 1] * 3;
    const i2 = indices[i * 3 + 2] * 3;
    const base = i * 9;
    triangles[base] = positions[i0];
    triangles[base + 1] = positions[i0 + 1];
    triangles[base + 2] = positions[i0 + 2];
    triangles[base + 3] = positions[i1];
    triangles[base + 4] = positions[i1 + 1];
    triangles[base + 5] = positions[i1 + 2];
    triangles[base + 6] = positions[i2];
    triangles[base + 7] = positions[i2 + 1];
    triangles[base + 8] = positions[i2 + 2];
  }

  // Build triangle color data for sampling
  let triColors = null;
  if (colors) {
    triColors = new Float32Array(triangleCount * 9);
    for (let i = 0; i < triangleCount; i++) {
      const i0 = indices[i * 3] * 3;
      const i1 = indices[i * 3 + 1] * 3;
      const i2 = indices[i * 3 + 2] * 3;
      const base = i * 9;
      triColors[base] = colors[i0];
      triColors[base + 1] = colors[i0 + 1];
      triColors[base + 2] = colors[i0 + 2];
      triColors[base + 3] = colors[i1];
      triColors[base + 4] = colors[i1 + 1];
      triColors[base + 5] = colors[i1 + 2];
      triColors[base + 6] = colors[i2];
      triColors[base + 7] = colors[i2 + 1];
      triColors[base + 8] = colors[i2 + 2];
    }
  }

  // Build triangle UV data for texture sampling
  let triUVs = null;
  if (uvs) {
    triUVs = new Float32Array(triangleCount * 6);
    for (let i = 0; i < triangleCount; i++) {
      const i0 = indices[i * 3] * 2;
      const i1 = indices[i * 3 + 1] * 2;
      const i2 = indices[i * 3 + 2] * 2;
      const base = i * 6;
      triUVs[base] = uvs[i0];
      triUVs[base + 1] = uvs[i0 + 1];
      triUVs[base + 2] = uvs[i1];
      triUVs[base + 3] = uvs[i1 + 1];
      triUVs[base + 4] = uvs[i2];
      triUVs[base + 5] = uvs[i2 + 1];
    }
  }

  // Compute AABB
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }

  // Add small padding to prevent boundary issues
  const padding = Math.max(maxX - minX, maxY - minY, maxZ - minZ) * 0.01;
  minX -= padding; minY -= padding; minZ -= padding;
  maxX += padding; maxY += padding; maxZ += padding;

  const N = resolution;
  const sizeX = maxX - minX;
  const sizeY = maxY - minY;
  const sizeZ = maxZ - minZ;
  const cellX = sizeX / N;
  const cellY = sizeY / N;
  const cellZ = sizeZ / N;

  const voxels = new Uint8Array(N * N * N);
  const colorsRGB = new Uint8Array(N * N * N * 3);

  // Ray-casting along Y axis (vertical columns)
  // For each (x, z) column, cast a ray downward and use even-odd rule
  const totalColumns = N * N;
  let processedColumns = 0;
  const progressInterval = Math.max(1, Math.floor(totalColumns / 100));

  for (let ix = 0; ix < N; ix++) {
    for (let iz = 0; iz < N; iz++) {
      // Ray origin at column center
      const rayX = minX + (ix + 0.5) * cellX;
      const rayZ = minZ + (iz + 0.5) * cellZ;

      // Find all ray-triangle intersections along Y
      const intersections = [];

      for (let t = 0; t < triangleCount; t++) {
        const base = t * 9;
        const hit = rayTriangleIntersectY(
          rayX, rayZ,
          triangles[base], triangles[base + 1], triangles[base + 2],
          triangles[base + 3], triangles[base + 4], triangles[base + 5],
          triangles[base + 6], triangles[base + 7], triangles[base + 8]
        );

        if (hit !== null) {
          intersections.push({ y: hit, triIndex: t });
        }
      }

      // Sort by Y coordinate
      intersections.sort((a, b) => a.y - b.y);

      // Even-odd fill
      for (let p = 0; p + 1 < intersections.length; p += 2) {
        const yStart = intersections[p].y;
        const yEnd = intersections[p + 1].y;

        // Fill voxels between these two intersections
        const iyStart = Math.max(0, Math.floor((yStart - minY) / cellY));
        const iyEnd = Math.min(N - 1, Math.floor((yEnd - minY) / cellY));

        for (let iy = iyStart; iy <= iyEnd; iy++) {
          const voxelIdx = ix + iy * N + iz * N * N;
          voxels[voxelIdx] = 1;
        }
      }

      // Assign colors to surface voxels (nearest triangle)
      for (let i = 0; i < intersections.length; i++) {
        const { y, triIndex } = intersections[i];
        const iy = Math.min(N - 1, Math.max(0, Math.floor((y - minY) / cellY)));
        const voxelIdx = ix + iy * N + iz * N * N;

        if (voxels[voxelIdx]) {
          sampleColor(
            colorsRGB, voxelIdx,
            rayX, y, rayZ,
            triIndex,
            triangles, triColors, triUVs,
            textureData, textureWidth, textureHeight
          );
        }
      }

      // Color interior voxels by nearest surface
      for (let iy = 0; iy < N; iy++) {
        const voxelIdx = ix + iy * N + iz * N * N;
        if (voxels[voxelIdx] && colorsRGB[voxelIdx * 3] === 0 && colorsRGB[voxelIdx * 3 + 1] === 0 && colorsRGB[voxelIdx * 3 + 2] === 0) {
          // Find nearest colored voxel in same column
          let nearestDist = Infinity;
          let nearestColor = null;
          for (const { y, triIndex } of intersections) {
            const dist = Math.abs((minY + (iy + 0.5) * cellY) - y);
            if (dist < nearestDist) {
              nearestDist = dist;
              nearestColor = triIndex;
            }
          }
          if (nearestColor !== null) {
            const vy = minY + (iy + 0.5) * cellY;
            sampleColor(
              colorsRGB, voxelIdx,
              rayX, vy, rayZ,
              nearestColor,
              triangles, triColors, triUVs,
              textureData, textureWidth, textureHeight
            );
          }
        }
      }

      processedColumns++;
      if (processedColumns % progressInterval === 0) {
        self.postMessage({
          type: 'progress',
          data: { progress: processedColumns / totalColumns },
        });
      }
    }
  }

  // Final progress
  self.postMessage({ type: 'progress', data: { progress: 1 } });

  return { voxels, colorsRGB, resolution: N };
}

/**
 * Ray-triangle intersection test for a vertical (Y-axis) ray.
 * Ray starts at (rayX, +infinity, rayZ) pointing downward.
 * Returns the Y coordinate of intersection, or null.
 */
function rayTriangleIntersectY(rayX, rayZ, v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z) {
  // Project triangle onto XZ plane and check if ray point is inside
  const e1x = v1x - v0x;
  const e1z = v1z - v0z;
  const e2x = v2x - v0x;
  const e2z = v2z - v0z;

  // 2D cross product for area
  const det = e1x * e2z - e1z * e2x;
  if (Math.abs(det) < 1e-10) return null; // Degenerate triangle in XZ

  const invDet = 1.0 / det;
  const dx = rayX - v0x;
  const dz = rayZ - v0z;

  // Barycentric coordinates
  const u = (dx * e2z - dz * e2x) * invDet;
  if (u < 0 || u > 1) return null;

  const v = (e1x * dz - e1z * dx) * invDet;
  if (v < 0 || u + v > 1) return null;

  // Compute Y at intersection point using barycentric interpolation
  const y = v0y + u * (v1y - v0y) + v * (v2y - v0y);
  return y;
}

/**
 * Sample color at a voxel from the nearest triangle.
 */
function sampleColor(colorsRGB, voxelIdx, px, py, pz, triIndex, triangles, triColors, triUVs, textureData, textureWidth, textureHeight) {
  const base = triIndex * 9;
  const v0x = triangles[base], v0y = triangles[base + 1], v0z = triangles[base + 2];
  const v1x = triangles[base + 3], v1y = triangles[base + 4], v1z = triangles[base + 5];
  const v2x = triangles[base + 6], v2y = triangles[base + 7], v2z = triangles[base + 8];

  // Compute barycentric coordinates for the point on the triangle
  const bary = computeBarycentric(px, py, pz, v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z);

  let r = 180, g = 180, b = 180; // Default gray

  if (triUVs && textureData && textureWidth > 0) {
    // Sample from texture using UV coordinates
    const uvBase = triIndex * 6;
    const u = bary.u * triUVs[uvBase] + bary.v * triUVs[uvBase + 2] + bary.w * triUVs[uvBase + 4];
    const v = bary.u * triUVs[uvBase + 1] + bary.v * triUVs[uvBase + 3] + bary.w * triUVs[uvBase + 5];

    // Clamp UV to [0, 1] with wrapping
    const tu = ((u % 1) + 1) % 1;
    const tv = ((v % 1) + 1) % 1;

    const tx = Math.min(textureWidth - 1, Math.floor(tu * textureWidth));
    const ty = Math.min(textureHeight - 1, Math.floor((1 - tv) * textureHeight));
    const texIdx = (ty * textureWidth + tx) * 4;

    r = textureData[texIdx];
    g = textureData[texIdx + 1];
    b = textureData[texIdx + 2];
  } else if (triColors) {
    // Sample from vertex colors
    const colBase = triIndex * 9;
    r = Math.round((bary.u * triColors[colBase] + bary.v * triColors[colBase + 3] + bary.w * triColors[colBase + 6]) * 255);
    g = Math.round((bary.u * triColors[colBase + 1] + bary.v * triColors[colBase + 4] + bary.w * triColors[colBase + 7]) * 255);
    b = Math.round((bary.u * triColors[colBase + 2] + bary.v * triColors[colBase + 5] + bary.w * triColors[colBase + 8]) * 255);
  }

  const cIdx = voxelIdx * 3;
  colorsRGB[cIdx] = Math.max(0, Math.min(255, r));
  colorsRGB[cIdx + 1] = Math.max(0, Math.min(255, g));
  colorsRGB[cIdx + 2] = Math.max(0, Math.min(255, b));
}

/**
 * Compute barycentric coordinates of point P in triangle (v0, v1, v2).
 */
function computeBarycentric(px, py, pz, v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z) {
  const e0x = v1x - v0x, e0y = v1y - v0y, e0z = v1z - v0z;
  const e1x = v2x - v0x, e1y = v2y - v0y, e1z = v2z - v0z;
  const epx = px - v0x, epy = py - v0y, epz = pz - v0z;

  const d00 = e0x * e0x + e0y * e0y + e0z * e0z;
  const d01 = e0x * e1x + e0y * e1y + e0z * e1z;
  const d11 = e1x * e1x + e1y * e1y + e1z * e1z;
  const d20 = epx * e0x + epy * e0y + epz * e0z;
  const d21 = epx * e1x + epy * e1y + epz * e1z;

  const denom = d00 * d11 - d01 * d01;
  if (Math.abs(denom) < 1e-10) {
    return { u: 1 / 3, v: 1 / 3, w: 1 / 3 };
  }

  const v = (d11 * d20 - d01 * d21) / denom;
  const w = (d00 * d21 - d01 * d20) / denom;
  const u = 1.0 - v - w;

  return { u: Math.max(0, u), v: Math.max(0, v), w: Math.max(0, w) };
}
