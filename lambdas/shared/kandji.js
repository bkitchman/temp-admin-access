// Kandji API helpers
const KANDJI_BASE_URL = process.env.KANDJI_BASE_URL;
const KANDJI_API_TOKEN = process.env.KANDJI_API_TOKEN;
const ELEVATION_TAG = process.env.KANDJI_ELEVATION_TAG;
const LOG_COLLECTION_TAG = process.env.KANDJI_LOG_COLLECTION_TAG;

function getHeaders() {
  return {
    Authorization: `Bearer ${KANDJI_API_TOKEN}`,
    'Content-Type': 'application/json;charset=utf-8',
    Accept: 'application/json',
    'Cache-Control': 'no-cache'
  };
}

async function kandjiRequest(method, path, body, attempt = 1) {
  const url = `${KANDJI_BASE_URL}${path}`;
  console.log(`Kandji request: ${method} ${url}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
  const options = { method, headers: getHeaders() };
  if (body !== undefined) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);

  if (!response.ok) {
    // N6-12: log only the status code for 5xx — response body may contain device details.
    // N8-15: for 4xx errors, log the first 200 chars of the body — PII unlikely in error
    // responses, and the detail (e.g. "device not found" vs "rate limit") aids debugging.
    let errDetail = '';
    if (response.status >= 400 && response.status < 500) {
      try {
        const errText = await response.text();
        errDetail = ` — ${errText.slice(0, 200)}`;
      } catch { /* ignore read errors */ }
    }
    console.error(`Kandji ${method} ${path} failed: HTTP ${response.status}${errDetail}`);
    // N7-10: retry on transient 5xx/429 — do not retry 4xx (auth/not-found errors)
    if (attempt < 3 && (response.status >= 500 || response.status === 429)) {
      const backoffMs = attempt * 1000;
      console.warn(`Kandji retrying in ${backoffMs}ms...`);
      await new Promise(r => setTimeout(r, backoffMs));
      return kandjiRequest(method, path, body, attempt + 1);
    }
    throw new Error(`Kandji API error: HTTP ${response.status}`);
  }

  if (response.status === 204) return null;
  const text = await response.text();
  if (!text || text.trim() === '') return null;
  return JSON.parse(text);
}

// Resolve serial number to Kandji device object — returns { device_id, tags, ... }
async function getDeviceBySerial(serial) {
  const devices = await kandjiRequest('GET', `/v1/devices?serial_number=${encodeURIComponent(serial)}`);
  if (!devices || devices.length === 0) {
    throw new Error(`No Kandji device found for serial: ${serial}`);
  }
  return devices[0];
}

// Get full device details including current tags
async function getDevice(deviceId) {
  return kandjiRequest('GET', `/v1/devices/${deviceId}`);
}

// Get the current tags for a device
async function getDeviceTags(deviceId) {
  const device = await getDevice(deviceId);
  return Array.isArray(device.tags) ? device.tags : [];
}

// Update a device's full tag array — Kandji requires the complete list every time
async function setDeviceTags(deviceId, tags) {
  return kandjiRequest('PATCH', `/v1/devices/${deviceId}`, { tags });
}

// Add a tag to a device, preserving all existing tags
async function addTag(deviceId, tagName) {
  const currentTags = await getDeviceTags(deviceId);
  if (currentTags.includes(tagName)) {
    console.log(`Tag "${tagName}" already present on device ${deviceId}, skipping`);
    return;
  }
  const updatedTags = [...currentTags, tagName];
  console.log(`Setting tags on device ${deviceId}:`, updatedTags);
  return setDeviceTags(deviceId, updatedTags);
}

// Remove a tag from a device, preserving all other existing tags
async function removeTag(deviceId, tagName) {
  const currentTags = await getDeviceTags(deviceId);
  if (!currentTags.includes(tagName)) {
    console.log(`Tag "${tagName}" not present on device ${deviceId}, skipping`);
    return;
  }
  const updatedTags = currentTags.filter(t => t !== tagName);
  console.log(`Setting tags on device ${deviceId}:`, updatedTags);
  return setDeviceTags(deviceId, updatedTags);
}

// Assign the elevation tag — scopes SAP Privileges library items to device
async function assignElevationTag(deviceId) {
  return addTag(deviceId, ELEVATION_TAG);
}

// Remove the elevation tag — revokes the Privileges config profile
async function removeElevationTag(deviceId) {
  return removeTag(deviceId, ELEVATION_TAG);
}

// Assign the log collection tag — triggers collect-sudo-log.sh on next MDM check-in
async function assignLogCollectionTag(deviceId) {
  return addTag(deviceId, LOG_COLLECTION_TAG);
}

// Remove the log collection tag after log has been collected
async function removeLogCollectionTag(deviceId) {
  return removeTag(deviceId, LOG_COLLECTION_TAG);
}

// Lock the device immediately via MDM.
async function lockDevice(deviceId) {
  await kandjiRequest('POST', `/v1/devices/${deviceId}/action/lock`, {});
}

module.exports = {
  getDeviceBySerial,
  getDevice,
  getDeviceTags,
  assignElevationTag,
  removeElevationTag,
  assignLogCollectionTag,
  removeLogCollectionTag,
  lockDevice
};
