// What the page says when this browser cannot run the game (roadmap G8: a
// clear message where WebGPU is missing, instead of a raw error).

/** The error is a missing WebGPU (no navigator.gpu, or no adapter), not a fault in the game. */
export const webgpuMissing = (message: string) => /WebGPU unavailable|no WebGPU adapter/.test(message);

/** The card shown in its place. */
export const NO_WEBGPU_HTML = `
  <div class="name" style="font-size:20px;font-weight:700;margin-bottom:6px">This browser can't run Keystone</div>
  <p style="margin:0 0 8px">Keystone simulates thousands of blocks on your graphics card with <b>WebGPU</b>, which this browser has turned off or doesn't have.</p>
  <p style="margin:0 0 8px">Open this page in a recent <b>Chrome</b> or <b>Edge</b> on a laptop or desktop (Windows, macOS or ChromeOS). Phones and older browsers mostly can't run it yet.</p>
  <p style="margin:0;color:#9aa3b8;font-size:12px">If you are already in Chrome: check that hardware acceleration is on (Settings, System) and that chrome://gpu lists WebGPU as available.</p>`;
