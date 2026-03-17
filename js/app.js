/**
 * ComfyVoxelizer - Main Application
 * State machine: IDLE → GENERATING_IMAGE → GENERATING_MESH → VOXELIZING → RENDERING → COMPLETE, ERROR
 */
import CONFIG from './config.js';
import { ComfyUIClient } from './comfyui-client.js';
import { WorkflowBuilder } from './workflow-builder.js';
import { Voxelizer } from './voxelizer.js';
import { VoxelRenderer } from './voxel-renderer.js';
import { Exporter } from './exporter.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Application states
const State = {
  IDLE: 'IDLE',
  GENERATING_IMAGE: 'GENERATING_IMAGE',
  GENERATING_MESH: 'GENERATING_MESH',
  VOXELIZING: 'VOXELIZING',
  RENDERING: 'RENDERING',
  COMPLETE: 'COMPLETE',
  ERROR: 'ERROR',
};

class App {
  constructor() {
    this.state = State.IDLE;
    this.client = new ComfyUIClient();
    this.workflowBuilder = new WorkflowBuilder();
    this.voxelizer = new Voxelizer();
    this.renderer = null;
    this.gltfScene = null;
    this.geometryData = null;
    this.voxelData = null;
    this.generatedImageFilename = null;
    this.errorMessage = '';
    this.debounceTimer = null;

    this._bindUI();
    this._setupEventListeners();
    this._connectToComfyUI();
  }

  // --- UI Binding ---

  _bindUI() {
    // Controls
    this.promptInput = document.getElementById('prompt-input');
    this.imageTo3DSelect = document.getElementById('image-to-3d-model');
    this.textToImageSelect = document.getElementById('text-to-image-model');
    this.generateBtn = document.getElementById('generate-btn');
    this.retryBtn = document.getElementById('retry-btn');
    this.serverUrlInput = document.getElementById('server-url');
    this.connectBtn = document.getElementById('connect-btn');
    this.connectionDot = document.getElementById('connection-dot');
    this.connectionText = document.getElementById('connection-text');

    // Progress
    this.progressSection = document.getElementById('progress-section');
    this.stageLabel = document.getElementById('stage-label');
    this.stageProgressBar = document.getElementById('stage-progress-bar');
    this.overallProgressBar = document.getElementById('overall-progress-bar');

    // Image preview
    this.previewSection = document.getElementById('preview-section');
    this.previewImage = document.getElementById('preview-image');

    // Voxel controls
    this.voxelControls = document.getElementById('voxel-controls');
    this.resolutionSlider = document.getElementById('resolution-slider');
    this.resolutionValue = document.getElementById('resolution-value');
    this.exportVoxBtn = document.getElementById('export-vox-btn');
    this.exportJsonBtn = document.getElementById('export-json-btn');

    // Error
    this.errorSection = document.getElementById('error-section');
    this.errorMessage_el = document.getElementById('error-message');

    // Canvas
    this.canvasContainer = document.getElementById('canvas-container');
    this.canvasPlaceholder = document.getElementById('canvas-placeholder');

    // Demo
    this.demoBtn = document.getElementById('demo-btn');
    this.demoModelSelect = document.getElementById('demo-model-select');
  }

  _setupEventListeners() {
    this.generateBtn.addEventListener('click', () => this._startPipeline());
    this.retryBtn.addEventListener('click', () => this._retry());
    this.connectBtn.addEventListener('click', () => this._reconnect());

    this.resolutionSlider.addEventListener('input', (e) => {
      this.resolutionValue.textContent = e.target.value;
      this._debouncedRevoxelize();
    });

    this.exportVoxBtn.addEventListener('click', () => this._exportVox());
    this.exportJsonBtn.addEventListener('click', () => this._exportJson());

    // Enter key in prompt starts pipeline
    this.promptInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.ctrlKey) {
        e.preventDefault();
        this._startPipeline();
      }
    });

    // Demo button
    this.demoBtn.addEventListener('click', () => this._startDemo());
  }

  // --- State Management ---

  _setState(newState) {
    this.state = newState;
    this._updateUI();
  }

  _updateUI() {
    const idle = this.state === State.IDLE;
    const complete = this.state === State.COMPLETE;
    const error = this.state === State.ERROR;
    const busy = !idle && !complete && !error;

    // Enable/disable controls
    this.promptInput.disabled = busy;
    this.imageTo3DSelect.disabled = busy;
    this.textToImageSelect.disabled = busy;
    this.generateBtn.disabled = busy;
    this.demoBtn.disabled = busy;

    // Show/hide progress
    this.progressSection.classList.toggle('hidden', idle || error);

    // Show/hide voxel controls
    this.voxelControls.classList.toggle('hidden', !complete);

    // Show/hide error
    this.errorSection.classList.toggle('hidden', !error);
    if (error) {
      this.errorMessage_el.textContent = this.errorMessage;
    }

    // Update generate button text
    if (busy) {
      this.generateBtn.textContent = 'Processing...';
    } else {
      this.generateBtn.textContent = 'Generate';
    }

    // Stage labels
    switch (this.state) {
      case State.GENERATING_IMAGE:
        this.stageLabel.textContent = 'Stage 1/4: Generating Image...';
        this._setOverallProgress(0);
        break;
      case State.GENERATING_MESH:
        this.stageLabel.textContent = 'Stage 2/4: Generating 3D Mesh...';
        this._setOverallProgress(25);
        break;
      case State.VOXELIZING:
        this.stageLabel.textContent = 'Stage 3/4: Voxelizing Mesh...';
        this._setOverallProgress(50);
        break;
      case State.RENDERING:
        this.stageLabel.textContent = 'Stage 4/4: Rendering Voxels...';
        this._setOverallProgress(75);
        break;
      case State.COMPLETE:
        this._setOverallProgress(100);
        break;
    }
  }

  _setStageProgress(progress) {
    this.stageProgressBar.style.width = `${Math.round(progress * 100)}%`;
  }

  _setOverallProgress(percent) {
    this.overallProgressBar.style.width = `${percent}%`;
  }

  // --- ComfyUI Connection ---

  async _connectToComfyUI() {
    try {
      this.connectionDot.className = 'dot connecting';
      this.connectionText.textContent = 'Connecting...';

      // Set up WebSocket message handlers
      this.client.on('connection', (data) => {
        if (data.connected) {
          this.connectionDot.className = 'dot connected';
          this.connectionText.textContent = 'Connected';
        } else {
          this.connectionDot.className = 'dot disconnected';
          this.connectionText.textContent = 'Disconnected';
        }
      });

      this.client.on('progress', (data) => {
        if (data && data.max > 0) {
          this._setStageProgress(data.value / data.max);
        }
      });

      await this.client.connectWebSocket();
    } catch (err) {
      this.connectionDot.className = 'dot disconnected';
      this.connectionText.textContent = 'Disconnected';
      console.warn('Failed to connect to ComfyUI:', err.message);
    }
  }

  async _reconnect() {
    const newUrl = this.serverUrlInput.value.trim();
    if (newUrl) {
      await this.client.setServerUrl(newUrl);
    }
    await this._connectToComfyUI();
  }

  // --- Pipeline ---

  async _startPipeline() {
    const prompt = this.promptInput.value.trim();
    if (!prompt) {
      this._showError('Please enter a text prompt.');
      return;
    }

    if (!this.client.connected) {
      // Try to connect first before giving up
      try {
        this.connectionDot.className = 'dot connecting';
        this.connectionText.textContent = 'Connecting...';
        await this.client.connectWebSocket();
      } catch (err) {
        this.connectionDot.className = 'dot disconnected';
        this.connectionText.textContent = 'Disconnected';
        this._showError('Cannot connect to ComfyUI at ' + this.client.serverUrl + '. Make sure ComfyUI is running and the server URL is correct.');
        return;
      }
    }

    this.previewSection.classList.add('hidden');

    try {
      // Stage 1: Text-to-Image
      await this._generateImage(prompt);

      // Stage 2: Image-to-3D Mesh
      await this._generateMesh();

      // Stage 3: Voxelize
      await this._voxelizeMesh();

      // Stage 4: Render
      this._renderVoxels();

      this._setState(State.COMPLETE);
    } catch (err) {
      this._showError(err.message);
    }
  }

  async _generateImage(prompt) {
    this._setState(State.GENERATING_IMAGE);
    this._setStageProgress(0);

    const model = this.textToImageSelect.value;
    const workflow = await this.workflowBuilder.buildTextToImage(prompt, model);

    const promptId = await this.client.queuePrompt(workflow);
    const outputs = await this.client.waitForCompletion(promptId);

    // Find the SaveImage output
    let imageFilename = null;
    for (const nodeOutputs of Object.values(outputs)) {
      if (nodeOutputs.images && nodeOutputs.images.length > 0) {
        imageFilename = nodeOutputs.images[0].filename;
        break;
      }
    }

    if (!imageFilename) {
      throw new Error('No image was generated. Check your ComfyUI setup and models.');
    }

    this.generatedImageFilename = imageFilename;

    // Show preview
    const imageUrl = await this.client.getImageUrl(imageFilename);
    this.previewImage.src = imageUrl;
    this.previewSection.classList.remove('hidden');
    this._setStageProgress(1);
  }

  async _generateMesh() {
    this._setState(State.GENERATING_MESH);
    this._setStageProgress(0);

    const model = this.imageTo3DSelect.value;
    const workflow = await this.workflowBuilder.buildImageTo3D(this.generatedImageFilename, model);

    const promptId = await this.client.queuePrompt(workflow);
    const outputs = await this.client.waitForCompletion(promptId);

    // Find the mesh output (GLB file)
    let meshFilename = null;
    let meshSubfolder = '';
    for (const nodeOutputs of Object.values(outputs)) {
      // Check for mesh/gltf/glb outputs
      const files = nodeOutputs.meshes || nodeOutputs.files || nodeOutputs.gltfmesh || [];
      for (const f of files) {
        if (f.filename && (f.filename.endsWith('.glb') || f.filename.endsWith('.gltf'))) {
          meshFilename = f.filename;
          meshSubfolder = f.subfolder || '';
          break;
        }
      }
      if (meshFilename) break;
    }

    if (!meshFilename) {
      throw new Error('No 3D mesh was generated. Check your ComfyUI image-to-3D model setup.');
    }

    // Download and parse GLB
    const meshData = await this.client.getMeshData(meshFilename, meshSubfolder);
    await this._parseGLB(meshData);
    this._setStageProgress(1);
  }

  async _parseGLB(arrayBuffer) {
    return new Promise((resolve, reject) => {
      const loader = new GLTFLoader();
      loader.parse(arrayBuffer, '', (gltf) => {
        this.gltfScene = gltf.scene;
        try {
          this.geometryData = this.voxelizer.extractGeometry(gltf.scene);
          resolve();
        } catch (err) {
          reject(new Error(`Failed to extract geometry from GLB: ${err.message}`));
        }
      }, (err) => {
        reject(new Error(`Failed to parse GLB file: ${err.message || err}`));
      });
    });
  }

  async _voxelizeMesh() {
    this._setState(State.VOXELIZING);
    this._setStageProgress(0);

    const resolution = parseInt(this.resolutionSlider.value, 10);
    this.voxelData = await this.voxelizer.voxelize(
      this.geometryData,
      resolution,
      (progress) => this._setStageProgress(progress)
    );
    this._setStageProgress(1);
  }

  _renderVoxels() {
    this._setState(State.RENDERING);

    // Hide placeholder
    if (this.canvasPlaceholder) {
      this.canvasPlaceholder.style.display = 'none';
    }

    if (!this.renderer) {
      this.renderer = new VoxelRenderer(this.canvasContainer);
    }
    this.renderer.init();
    this.renderer.renderVoxels(
      this.voxelData.voxels,
      this.voxelData.colorsRGB,
      this.voxelData.resolution
    );
    this._setStageProgress(1);
  }

  // --- Demo Mode ---

  async _startDemo() {
    const modelUrl = this.demoModelSelect.value;
    this.errorSection.classList.add('hidden');

    try {
      // Skip stages 1 & 2 — go straight to loading the GLB
      this._setState(State.GENERATING_MESH);
      this.stageLabel.textContent = 'Loading demo 3D model...';
      this._setStageProgress(0.5);
      this._setOverallProgress(25);

      // Fetch the demo GLB file
      const response = await fetch(modelUrl);
      if (!response.ok) {
        throw new Error(`Failed to load demo model: ${response.status}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      this._setStageProgress(1);

      // Parse GLB
      await this._parseGLB(arrayBuffer);
      this._setOverallProgress(50);

      // Stage 3: Voxelize
      await this._voxelizeMesh();

      // Stage 4: Render
      this._renderVoxels();

      this._setState(State.COMPLETE);
    } catch (err) {
      this._showError(err.message);
    }
  }

  // --- Re-voxelize on slider change ---

  _debouncedRevoxelize() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (!this.geometryData) return;

    this.debounceTimer = setTimeout(async () => {
      try {
        await this._voxelizeMesh();
        this._renderVoxels();
        this._setState(State.COMPLETE);
      } catch (err) {
        this._showError(err.message);
      }
    }, CONFIG.debounceMs);
  }

  // --- Export ---

  _exportVox() {
    if (!this.voxelData) return;
    const blob = Exporter.exportVox(
      this.voxelData.voxels,
      this.voxelData.colorsRGB,
      this.voxelData.resolution
    );
    Exporter.download(blob, 'voxel_model.vox');
  }

  _exportJson() {
    if (!this.voxelData) return;
    const blob = Exporter.exportJSON(
      this.voxelData.voxels,
      this.voxelData.colorsRGB,
      this.voxelData.resolution
    );
    Exporter.download(blob, 'voxel_model.json');
  }

  // --- Error Handling ---

  _showError(message) {
    this.errorMessage = message;
    this._setState(State.ERROR);
    console.error('ComfyVoxelizer Error:', message);
  }

  _retry() {
    this.errorSection.classList.add('hidden');
    this._setState(State.IDLE);
  }
}

// Initialize the app when the DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  window.comfyVoxelizer = new App();
});
