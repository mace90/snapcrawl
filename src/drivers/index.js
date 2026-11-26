import { IosDevice, DEFAULT_WDA_URL, listDevices } from './ios-device.js';
import { IosSimulator, listSimulators } from './ios-sim.js';

export const PLATFORMS = ['ios-sim', 'ios-device'];

// One place that turns config + CLI/UI options into a driver.
export function makeDriver({ platform = 'ios-sim', udid, bundleId, wdaUrl } = {}) {
  if (platform === 'ios-device') return new IosDevice({ udid, bundleId, wdaUrl: wdaUrl || DEFAULT_WDA_URL });
  if (platform === 'ios-sim') return new IosSimulator({ udid: udid || 'booted', bundleId });
  throw new Error(`unknown device.platform "${platform}" · use ${PLATFORMS.join(' or ')}`);
}

// Simulators and USB devices in one list; a failing source is reported, not fatal.
export async function listAllDevices() {
  const [sims, devs] = await Promise.allSettled([listSimulators(), listDevices()]);
  return {
    sims: sims.status === 'fulfilled' ? sims.value : [],
    devices: devs.status === 'fulfilled' ? devs.value : [],
    errors: [sims, devs].filter((r) => r.status === 'rejected').map((r) => r.reason.message),
  };
}
