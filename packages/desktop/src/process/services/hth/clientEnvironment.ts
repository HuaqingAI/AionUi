/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'crypto';
import { networkInterfaces } from 'os';

export type AionUiClientPlatform = 'windows_x64' | 'mac_arm64' | 'mac_x64';

type NetworkInterfaces = ReturnType<typeof networkInterfaces>;

const INSTALLATION_ID_PREFIX = 'mac_';

export function resolveAionUiClientPlatform(
  platform = process.platform,
  arch = process.arch
): AionUiClientPlatform | null {
  if (platform === 'win32' && arch === 'x64') {
    return 'windows_x64';
  }
  if (platform === 'darwin' && arch === 'arm64') {
    return 'mac_arm64';
  }
  if (platform === 'darwin' && arch === 'x64') {
    return 'mac_x64';
  }
  return null;
}

export function resolvePreferredLanIPv4(networks: NetworkInterfaces = networkInterfaces()): string {
  for (const network of Object.values(networks)) {
    if (!network) continue;
    for (const address of network) {
      const isIPv4 = address.family === 'IPv4' || (address.family as unknown) === 4;
      if (!isIPv4 || address.internal || !isRFC1918IPv4(address.address)) {
        continue;
      }
      return address.address;
    }
  }
  return '';
}

/**
 * Derives a deterministic, non-reversible installation identifier from the
 * machine's advertised network adapter MAC addresses. The raw addresses are
 * never sent to the server.
 */
export function resolveMacInstallationId(
  networks: NetworkInterfaces = networkInterfaces(),
  namespace = 'aionui'
): string | null {
  const macs = Array.from(
    new Set(
      Object.values(networks)
        .flatMap((network) => network ?? [])
        .map((address) => address.mac.toLowerCase().replace(/[:-]/g, ''))
        .filter((mac) => /^[0-9a-f]{12}$/.test(mac) && !/^0+$/.test(mac) && !/^f+$/.test(mac))
    )
  ).toSorted();
  if (macs.length === 0) {
    return null;
  }
  const digest = createHash('sha256')
    .update(`${namespace}:installation-mac:v1:${macs.join(',')}`)
    .digest('hex');
  return `${INSTALLATION_ID_PREFIX}${digest}`;
}

export function shouldRunClientHeartbeat(args = process.argv, e2eMode = process.env.AIONUI_E2E_TEST): boolean {
  if (e2eMode === '1') {
    return false;
  }
  return !args.some((arg) => arg === '--webui' || arg === '--resetpass' || arg === '--version' || arg === '-v');
}

function isRFC1918IPv4(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 4) {
    return false;
  }
  if (parts.some((part) => !/^\d+$/.test(part))) {
    return false;
  }
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}
