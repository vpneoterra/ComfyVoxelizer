/**
 * Voxelizer - Main Thread Module
 * Extracts geometry from Three.js GLTF scene, packages as transferable arrays,
 * and communicates with the voxelizer Web Worker.
 */
import * as THREE from 'three';

export class Voxelizer {
  constructor() {
    this.worker = null;
  }

  /**
   * Initialize the Web Worker.
   */
  init() {
    this.worker = new Worker('js/voxelizer-worker.js');
  }

  /**
   * Extract geometry data from a GLTF scene.
   * Merges all meshes into a single geometry.
   * @param {THREE.Group} scene - The loaded GLTF scene
   * @returns {Object} positions, indices, normals, uvs, colors, and texture data
   */
  extractGeometry(scene) {
    const meshes = [];
    scene.traverse((child) => {
      if (child.isMesh) {
        meshes.push(child);
      }
    });

    if (meshes.length === 0) {
      throw new Error('No meshes found in the GLB file');
    }

    // Collect all geometry data, applying world transforms
    let totalVertices = 0;
    let totalIndices = 0;
    const geometries = [];

    for (const mesh of meshes) {
      mesh.updateMatrixWorld(true);
      const geo = mesh.geometry;
      const posAttr = geo.attributes.position;
      const vertCount = posAttr.count;
      const idxCount = geo.index ? geo.index.count : vertCount;

      geometries.push({
        mesh,
        geometry: geo,
        vertexOffset: totalVertices,
        vertCount,
        idxCount,
      });

      totalVertices += vertCount;
      totalIndices += idxCount;
    }

    // Merge into flat arrays
    const positions = new Float32Array(totalVertices * 3);
    const indices = new Uint32Array(totalIndices);
    const hasColors = meshes.some(m => m.geometry.attributes.color);
    const colors = hasColors ? new Float32Array(totalVertices * 3) : null;
    const hasUVs = meshes.some(m => m.geometry.attributes.uv);
    const uvs = hasUVs ? new Float32Array(totalVertices * 2) : null;

    // Extract texture data from the first textured mesh
    let textureData = null;
    let textureWidth = 0;
    let textureHeight = 0;

    let idxOffset = 0;
    for (const { mesh, geometry, vertexOffset, vertCount, idxCount } of geometries) {
      const posAttr = geometry.attributes.position;
      const tempVec = new THREE.Vector3();

      // Copy positions with world transform applied
      for (let i = 0; i < vertCount; i++) {
        tempVec.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
        tempVec.applyMatrix4(mesh.matrixWorld);
        const base = (vertexOffset + i) * 3;
        positions[base] = tempVec.x;
        positions[base + 1] = tempVec.y;
        positions[base + 2] = tempVec.z;
      }

      // Copy indices
      if (geometry.index) {
        for (let i = 0; i < idxCount; i++) {
          indices[idxOffset + i] = geometry.index.getX(i) + vertexOffset;
        }
      } else {
        for (let i = 0; i < vertCount; i++) {
          indices[idxOffset + i] = vertexOffset + i;
        }
      }
      idxOffset += idxCount;

      // Copy vertex colors if available
      if (colors && geometry.attributes.color) {
        const colorAttr = geometry.attributes.color;
        for (let i = 0; i < vertCount; i++) {
          const base = (vertexOffset + i) * 3;
          colors[base] = colorAttr.getX(i);
          colors[base + 1] = colorAttr.getY(i);
          colors[base + 2] = colorAttr.getZ(i);
        }
      }

      // Copy UVs if available
      if (uvs && geometry.attributes.uv) {
        const uvAttr = geometry.attributes.uv;
        for (let i = 0; i < vertCount; i++) {
          const base = (vertexOffset + i) * 2;
          uvs[base] = uvAttr.getX(i);
          uvs[base + 1] = uvAttr.getY(i);
        }
      }

      // Extract texture data from material
      if (!textureData && mesh.material && mesh.material.map) {
        const tex = mesh.material.map;
        if (tex.image) {
          const canvas = document.createElement('canvas');
          canvas.width = tex.image.width || tex.image.videoWidth || 256;
          canvas.height = tex.image.height || tex.image.videoHeight || 256;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(tex.image, 0, 0, canvas.width, canvas.height);
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          textureData = new Uint8Array(imageData.data.buffer);
          textureWidth = canvas.width;
          textureHeight = canvas.height;
        }
      }
    }

    return {
      positions,
      indices,
      colors,
      uvs,
      textureData,
      textureWidth,
      textureHeight,
    };
  }

  /**
   * Run voxelization in a Web Worker.
   * @param {Object} geometryData - Output from extractGeometry
   * @param {number} resolution - Grid resolution (16-128)
   * @param {Function} onProgress - Progress callback (0-1)
   * @returns {Promise<{voxels: Uint8Array, colorsRGB: Uint8Array, resolution: number}>}
   */
  voxelize(geometryData, resolution, onProgress) {
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        this.init();
      }

      const { positions, indices, colors, uvs, textureData, textureWidth, textureHeight } = geometryData;

      // Clone arrays so originals remain usable for re-voxelization (slider changes)
      const posClone = new Float32Array(positions);
      const idxClone = new Uint32Array(indices);
      const colClone = colors ? new Float32Array(colors) : null;
      const uvClone = uvs ? new Float32Array(uvs) : null;
      const texClone = textureData ? new Uint8Array(textureData) : null;

      // Build transferable list from clones
      const transferables = [posClone.buffer, idxClone.buffer];
      if (colClone) transferables.push(colClone.buffer);
      if (uvClone) transferables.push(uvClone.buffer);
      if (texClone) transferables.push(texClone.buffer);

      this.worker.onmessage = (e) => {
        const { type, data } = e.data;
        switch (type) {
          case 'progress':
            if (onProgress) onProgress(data.progress);
            break;
          case 'result':
            resolve({
              voxels: data.voxels,
              colorsRGB: data.colorsRGB,
              resolution: data.resolution,
            });
            break;
          case 'error':
            reject(new Error(data.message));
            break;
        }
      };

      this.worker.onerror = (err) => {
        reject(new Error(`Worker error: ${err.message}`));
      };

      this.worker.postMessage({
        type: 'voxelize',
        data: {
          positions: posClone,
          indices: idxClone,
          colors: colClone,
          uvs: uvClone,
          textureData: texClone,
          textureWidth,
          textureHeight,
          resolution,
        },
      }, transferables);
    });
  }

  /**
   * Terminate the worker.
   */
  dispose() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }
}
