export function getWebGPUStatus(): { available: boolean; reason: string } {
  if (!("gpu" in navigator)) {
    return {
      available: false,
      reason: "WebGPU is not available in this browser. Use recent Chrome/Edge."
    };
  }

  return {
    available: true,
    reason: "WebGPU is available."
  };
}
