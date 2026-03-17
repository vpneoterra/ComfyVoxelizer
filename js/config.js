/**
 * ComfyVoxelizer Configuration
 */
const CONFIG = {
  comfyuiUrl: 'http://127.0.0.1:8188',
  defaultResolution: 64,
  maxResolution: 128,
  minResolution: 16,
  samplerSteps: 20,
  cfg: 7.0,
  samplerName: 'euler',
  scheduler: 'normal',
  negativePrompt: 'blurry, low quality, watermark, text',
  imageWidth: 1024,
  imageHeight: 1024,
  defaultTextToImageModel: 'flux',
  defaultImageTo3DModel: 'trellis2',
  debounceMs: 300,
  wsReconnectInterval: 3000,
  wsMaxReconnectAttempts: 10,
};

export default CONFIG;
