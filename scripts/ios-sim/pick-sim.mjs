#!/usr/bin/env node
/**
 * Pick the newest available iOS simulator runtime and an iPhone on it.
 *
 * `xcrun simctl list -j` is the only stable source of this information on a
 * GitHub macOS runner: the images differ per runner label (macos-15 has iOS
 * 18.x, macos-14 has iOS 17.x) and Apple renames the runtime bundles with every
 * Xcode, so nothing here may hard-code a device name or a runtime id.
 *
 * Prints one JSON object on stdout, and with --github-env also exports the
 * IOS_SIM_* variables that run.mjs and the workflow read.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

/** Newest model first: a plain `iPhone N` beats `iPhone SE`, `Pro` beats the rest. */
const MODEL_PREFERENCE = [
  /^iPhone \d{2} Pro Max$/,
  /^iPhone \d{2} Pro$/,
  /^iPhone \d{2} Plus$/,
  /^iPhone \d{2}$/,
  /^iPhone \d{2} mini$/,
  /^iPhone \d{2}e$/,
  /^iPhone SE \(3rd generation\)$/,
];

function run(args) {
  return execFileSync('xcrun', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/**
 * The inventory, from `xcrun simctl list -j` — or from SIMCTL_JSON, a file with the
 * same shape, so the picking logic can be exercised without a Mac.
 */
function readInventory() {
  const fixture = process.env.SIMCTL_JSON;
  if (fixture) return JSON.parse(readFileSync(fixture, 'utf8'));
  return JSON.parse(run(['simctl', 'list', '-j']));
}

function versionParts(version) {
  return String(version || '')
    .split(/[._-]/)
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}

/** Numeric, not lexical: "18.10" is newer than "18.9". */
function compareVersions(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (right[index] || 0) - (left[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function modelRank(name) {
  const rank = MODEL_PREFERENCE.findIndex((pattern) => pattern.test(name));
  return rank === -1 ? MODEL_PREFERENCE.length : rank;
}

/** "iPhone 17 Pro" -> 17, so within one rank the newer model wins. */
function modelNumber(name) {
  const match = /^iPhone\s+(\d{1,2})/.exec(name || '');
  return match ? Number.parseInt(match[1], 10) : 0;
}

function chooseDevice(runtime, devices) {
  const candidates = (devices[runtime.identifier] || []).filter(
    (device) => device.isAvailable !== false && /^iPhone/.test(device.name || ''),
  );
  if (!candidates.length) return null;

  const booted = candidates.filter((device) => device.state === 'Booted');
  const pool = booted.length ? booted : candidates;
  return [...pool].sort((a, b) => {
    const byModel = modelRank(a.name) - modelRank(b.name);
    if (byModel !== 0) return byModel;
    return modelNumber(b.name) - modelNumber(a.name);
  })[0];
}

function main() {
  let list;
  try {
    list = readInventory();
  } catch (error) {
    console.error(`Could not read the simulator inventory: ${error.message}`);
    process.exit(1);
  }

  const devices = list.devices || {};
  const runtimes = (list.runtimes || [])
    .filter((runtime) => runtime.platform === 'iOS' || /^com\.apple\.CoreSimulator\.SimRuntime\.iOS-/.test(runtime.identifier))
    .filter((runtime) => runtime.isAvailable !== false && runtime.version)
    .sort((a, b) => compareVersions(a.version, b.version));

  if (!runtimes.length) {
    console.error('No available iOS simulator runtime on this runner. Runtimes seen:');
    for (const runtime of list.runtimes || []) {
      console.error(`  ${runtime.name} available=${runtime.isAvailable}`);
    }
    process.exit(1);
  }

  for (const runtime of runtimes) {
    const device = chooseDevice(runtime, devices);
    if (!device) continue;

    const result = {
      udid: device.udid,
      deviceName: device.name,
      deviceState: device.state,
      runtimeIdentifier: runtime.identifier,
      runtimeName: runtime.name,
      // Appium wants the marketing version only: "18.5", not "iOS 18.5".
      platformVersion: String(runtime.version),
      allRuntimes: runtimes.map((entry) => entry.version),
    };
    console.log(JSON.stringify(result, null, 2));

    if (process.argv.includes('--github-env')) {
      const envFile = process.env.GITHUB_ENV;
      if (!envFile) {
        console.error('--github-env was given but GITHUB_ENV is not set');
        process.exit(1);
      }
      const lines = [
        `IOS_SIM_UDID=${result.udid}`,
        `IOS_SIM_DEVICE_NAME=${result.deviceName}`,
        `IOS_SIM_PLATFORM_VERSION=${result.platformVersion}`,
        `IOS_SIM_RUNTIME=${result.runtimeName}`,
      ];
      appendFileSync(envFile, `${lines.join('\n')}\n`);
    }
    return;
  }

  console.error('No available iPhone simulator found in any iOS runtime.');
  process.exit(1);
}

main();
