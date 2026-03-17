/**
 * Voxel Renderer
 * Three.js InstancedMesh renderer with OrbitControls for voxel display.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export class VoxelRenderer {
  constructor(container) {
    this.container = container;
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.controls = null;
    this.instancedMesh = null;
    this.animationId = null;
    this.initialized = false;
  }

  /**
   * Initialize the Three.js scene, camera, renderer, and controls.
   */
  init() {
    if (this.initialized) return;

    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a1a2e);

    // Camera
    const aspect = this.container.clientWidth / this.container.clientHeight;
    this.camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 1000);
    this.camera.position.set(100, 80, 100);
    this.camera.lookAt(0, 0, 0);

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.container.appendChild(this.renderer.domElement);

    // Lighting — bright enough to see voxel colors clearly
    const ambientLight = new THREE.AmbientLight(0xcccccc);
    this.scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(1, 2, 1.5);
    this.scene.add(directionalLight);

    const fillLight = new THREE.DirectionalLight(0xffffff, 0.3);
    fillLight.position.set(-1, 0.5, -1);
    this.scene.add(fillLight);

    // Orbit Controls
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.target.set(0, 0, 0);

    // Handle resize
    this._resizeObserver = new ResizeObserver(() => this._onResize());
    this._resizeObserver.observe(this.container);

    this.initialized = true;
    this._animate();
  }

  _onResize() {
    if (!this.renderer || !this.camera) return;
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  _animate() {
    this.animationId = requestAnimationFrame(() => this._animate());
    if (this.controls) this.controls.update();
    if (this.renderer && this.scene && this.camera) {
      this.renderer.render(this.scene, this.camera);
    }
  }

  /**
   * Render a voxel grid using InstancedMesh.
   * @param {Uint8Array} voxels - Flat array N³, 1=solid
   * @param {Uint8Array} colorsRGB - Flat array N³×3, RGB per voxel
   * @param {number} resolution - Grid resolution N
   */
  renderVoxels(voxels, colorsRGB, resolution) {
    if (!this.initialized) this.init();

    // Remove previous mesh
    if (this.instancedMesh) {
      this.scene.remove(this.instancedMesh);
      this.instancedMesh.geometry.dispose();
      this.instancedMesh.material.dispose();
      this.instancedMesh = null;
    }

    // Count solid voxels
    let solidCount = 0;
    for (let i = 0; i < voxels.length; i++) {
      if (voxels[i]) solidCount++;
    }

    if (solidCount === 0) return;

    // Create instanced mesh
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshPhongMaterial();
    this.instancedMesh = new THREE.InstancedMesh(geometry, material, solidCount);

    // Set up per-instance colors
    const colorArray = new Float32Array(solidCount * 3);

    const matrix = new THREE.Matrix4();
    const halfRes = resolution / 2;
    let instanceIdx = 0;

    for (let iz = 0; iz < resolution; iz++) {
      for (let iy = 0; iy < resolution; iy++) {
        for (let ix = 0; ix < resolution; ix++) {
          const voxelIdx = ix + iy * resolution + iz * resolution * resolution;
          if (!voxels[voxelIdx]) continue;

          // Position centered on origin
          matrix.makeTranslation(ix - halfRes, iy - halfRes, iz - halfRes);
          this.instancedMesh.setMatrixAt(instanceIdx, matrix);

          // Color
          const cIdx = voxelIdx * 3;
          colorArray[instanceIdx * 3] = colorsRGB[cIdx] / 255;
          colorArray[instanceIdx * 3 + 1] = colorsRGB[cIdx + 1] / 255;
          colorArray[instanceIdx * 3 + 2] = colorsRGB[cIdx + 2] / 255;

          instanceIdx++;
        }
      }
    }

    this.instancedMesh.instanceMatrix.needsUpdate = true;

    // Apply per-instance color attribute
    const colorAttr = new THREE.InstancedBufferAttribute(colorArray, 3);
    this.instancedMesh.instanceColor = colorAttr;

    this.scene.add(this.instancedMesh);

    // Adjust camera to fit the voxel grid
    const dist = resolution * 1.5;
    this.camera.position.set(dist * 0.7, dist * 0.5, dist * 0.7);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  /**
   * Dispose all Three.js resources.
   */
  dispose() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }

    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }

    if (this.instancedMesh) {
      this.scene.remove(this.instancedMesh);
      this.instancedMesh.geometry.dispose();
      this.instancedMesh.material.dispose();
      this.instancedMesh = null;
    }

    if (this.controls) {
      this.controls.dispose();
      this.controls = null;
    }

    if (this.renderer) {
      this.renderer.dispose();
      if (this.renderer.domElement && this.renderer.domElement.parentNode) {
        this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
      }
      this.renderer = null;
    }

    this.scene = null;
    this.camera = null;
    this.initialized = false;
  }
}
