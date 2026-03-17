/**
 * Workflow Builder
 * Loads ComfyUI workflow JSON templates and injects dynamic parameters.
 */
import CONFIG from './config.js';

export class WorkflowBuilder {
  constructor() {
    this.templateCache = {};
  }

  /**
   * Load a workflow template JSON file.
   */
  async loadTemplate(templatePath) {
    if (this.templateCache[templatePath]) {
      return structuredClone(this.templateCache[templatePath]);
    }

    const response = await fetch(templatePath);
    if (!response.ok) {
      throw new Error(`Failed to load workflow template: ${templatePath} (${response.status})`);
    }

    const template = await response.json();
    this.templateCache[templatePath] = template;
    return structuredClone(template);
  }

  /**
   * Build a text-to-image workflow.
   * @param {string} prompt - User's text prompt
   * @param {string} model - 'flux' or 'sdxl'
   * @returns {Object} ComfyUI workflow JSON
   */
  async buildTextToImage(prompt, model = CONFIG.defaultTextToImageModel) {
    const templatePath = model === 'flux'
      ? 'workflows/text-to-image-flux.json'
      : 'workflows/text-to-image-sdxl.json';

    const workflow = await this.loadTemplate(templatePath);

    // Find and inject parameters into the workflow nodes
    for (const [nodeId, node] of Object.entries(workflow)) {
      switch (node.class_type) {
        case 'CLIPTextEncode':
          // Inject prompt into positive encoder, leave negative as-is
          if (node.inputs.text !== undefined && !node._is_negative) {
            // Determine if this is the positive or negative prompt node
            // by checking if the text looks like a negative prompt
            if (node.inputs.text === '' || node.inputs.text === '{prompt}') {
              node.inputs.text = prompt;
            }
          }
          break;

        case 'KSampler':
          node.inputs.seed = Math.floor(Math.random() * 2 ** 32);
          node.inputs.steps = CONFIG.samplerSteps;
          node.inputs.cfg = CONFIG.cfg;
          node.inputs.sampler_name = CONFIG.samplerName;
          node.inputs.scheduler = CONFIG.scheduler;
          break;
      }
    }

    return workflow;
  }

  /**
   * Build an image-to-3D workflow.
   * @param {string} imageFilename - Filename of the generated image from Stage 1
   * @param {string} model - 'trellis2' or 'hunyuan3d'
   * @returns {Object} ComfyUI workflow JSON
   */
  async buildImageTo3D(imageFilename, model = CONFIG.defaultImageTo3DModel) {
    const templatePath = model === 'trellis2'
      ? 'workflows/image-to-3d-trellis2.json'
      : 'workflows/image-to-3d-hunyuan3d.json';

    const workflow = await this.loadTemplate(templatePath);

    // Inject the image filename into the appropriate load-image node
    for (const [nodeId, node] of Object.entries(workflow)) {
      switch (node.class_type) {
        case 'LoadImage':
        case 'Trellis2LoadImageWithTransparency':
          node.inputs.image = imageFilename;
          break;

        case 'Hy3DConditioning':
          if (node.inputs.image !== undefined) {
            node.inputs.image = imageFilename;
          }
          break;
      }
    }

    return workflow;
  }
}
