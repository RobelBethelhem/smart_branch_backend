/**
 * ZK9500 Fingerprint Scanner Native Integration
 *
 * This module interfaces with the ZKCapture.exe helper application
 * which uses the official ZKFinger SDK (libzkfpcsharp.dll)
 */

import { exec, spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to the ZKCapture helper executable
const ZKCAPTURE_PATH = path.join(__dirname, 'ZKCapture.exe');

// Check if ZKCapture.exe exists
const hasZKCapture = () => {
    try {
        return fs.existsSync(ZKCAPTURE_PATH);
    } catch {
        return false;
    }
};

/**
 * Execute ZKCapture command and parse JSON output
 */
async function executeZKCapture(args, timeout = 30000) {
    return new Promise((resolve, reject) => {
        const command = `"${ZKCAPTURE_PATH}" ${args}`;

        exec(command, { timeout, windowsHide: true }, (error, stdout, stderr) => {
            if (error && error.killed) {
                reject(new Error('Command timed out'));
                return;
            }

            // Try to parse JSON output
            try {
                const result = JSON.parse(stdout.trim());
                resolve(result);
            } catch (parseError) {
                // If JSON parse fails, check if it's an error
                if (error) {
                    reject(new Error(stderr || error.message));
                } else {
                    reject(new Error('Invalid response from ZKCapture: ' + stdout));
                }
            }
        });
    });
}

/**
 * Check if ZK9500 scanner is connected
 */
export async function checkZK9500Connected() {
    // First check if ZKCapture.exe exists
    if (!hasZKCapture()) {
        console.log('ZKCapture.exe not found, using fallback detection...');
        return await checkDeviceFallback();
    }

    try {
        const result = await executeZKCapture('check', 10000);
        return {
            connected: result.connected,
            deviceCount: result.deviceCount || 0,
            device: result.deviceCount > 0 ? 'ZK9500 Fingerprint Scanner' : null,
            method: 'sdk',
            message: result.message
        };
    } catch (error) {
        console.error('SDK check failed:', error.message);
        // Fallback to basic detection
        return await checkDeviceFallback();
    }
}

/**
 * Fallback device detection using Windows commands
 */
async function checkDeviceFallback() {
    return new Promise((resolve) => {
        // Use PowerShell to check for USB fingerprint devices
        const psCommand = `Get-WmiObject Win32_USBControllerDevice | ForEach-Object { [wmi]($_.Dependent) } | Where-Object { $_.Description -match 'ZK|Fingerprint|Biometric' } | Select-Object -First 1 Description`;

        exec(`powershell -Command "${psCommand}"`, { timeout: 5000 }, (error, stdout) => {
            const hasDevice = !error && stdout.trim().length > 0;
            resolve({
                connected: hasDevice,
                deviceCount: hasDevice ? 1 : 0,
                device: hasDevice ? stdout.trim() : null,
                method: 'wmi',
                message: hasDevice ? 'Scanner detected via WMI' : 'No scanner detected'
            });
        });
    });
}

/**
 * Capture fingerprint using ZKFinger SDK
 */
export async function captureFingerprint(timeout = 20000) {
    // Check if ZKCapture.exe exists
    if (!hasZKCapture()) {
        console.log('ZKCapture.exe not found, using simulation mode');
        return {
            success: true,
            template: generateSimulatedTemplate(),
            simulated: true,
            message: 'Fingerprint captured (simulation - ZKCapture.exe not built)'
        };
    }

    try {
        console.log('Capturing fingerprint using ZKFinger SDK...');
        const result = await executeZKCapture('capture', timeout);

        if (result.success) {
            return {
                success: true,
                template: result.template,
                templateSize: result.templateSize,
                imageWidth: result.imageWidth,
                imageHeight: result.imageHeight,
                simulated: false,
                message: result.message
            };
        } else {
            return {
                success: false,
                message: result.message || 'Capture failed'
            };
        }
    } catch (error) {
        console.error('SDK capture failed:', error.message);

        // If SDK fails, offer simulation mode
        if (error.message.includes('timeout') || error.message.includes('timed out')) {
            return {
                success: false,
                message: 'Capture timeout - no finger detected. Please try again.'
            };
        }

        // Fallback to simulation for other errors
        console.log('Falling back to simulation mode');
        return {
            success: true,
            template: generateSimulatedTemplate(),
            simulated: true,
            message: 'Fingerprint captured (simulation - SDK error: ' + error.message + ')'
        };
    }
}

/**
 * Verify two fingerprint templates match
 */
export async function verifyFingerprints(template1, template2, threshold = 50) {
    // Check if ZKCapture.exe exists
    if (!hasZKCapture()) {
        // Simple string comparison for simulation
        const match = template1 === template2;
        return {
            match,
            score: match ? 100 : 0,
            simulated: true,
            message: match ? 'Templates match (simulated)' : 'Templates do not match (simulated)'
        };
    }

    try {
        // Escape the base64 strings for command line
        const result = await executeZKCapture(`verify "${template1}" "${template2}"`, 10000);

        return {
            match: result.match,
            score: result.score || 0,
            simulated: false,
            message: result.message
        };
    } catch (error) {
        console.error('SDK verify failed:', error.message);

        // Fallback to simple comparison
        const match = template1 === template2;
        return {
            match,
            score: match ? 100 : 0,
            simulated: true,
            message: 'Verification completed (fallback mode)'
        };
    }
}

/**
 * Generate a simulated fingerprint template for testing
 */
export function generateSimulatedTemplate() {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 15);
    const uniqueId = Math.random().toString(36).substring(2, 10);

    const templateData = {
        version: '1.0',
        type: 'ZK9500_SIMULATED',
        timestamp,
        data: `${random}${uniqueId}`,
        checksum: Buffer.from(`${timestamp}${random}`).toString('base64').slice(0, 8)
    };

    return Buffer.from(JSON.stringify(templateData)).toString('base64');
}

/**
 * Initialize the fingerprint device
 */
export async function initializeDevice() {
    const status = await checkZK9500Connected();

    return {
        initialized: status.connected,
        device: status.device,
        method: status.method,
        sdkAvailable: hasZKCapture(),
        message: status.connected
            ? `Scanner ready (${status.method})`
            : 'No scanner detected. Please connect ZK9500.'
    };
}

/**
 * Get SDK status
 */
export function getSDKStatus() {
    return {
        zkCaptureExists: hasZKCapture(),
        zkCapturePath: ZKCAPTURE_PATH,
        message: hasZKCapture()
            ? 'ZKCapture.exe found - using real SDK'
            : 'ZKCapture.exe not found - run build.bat to compile'
    };
}

export default {
    checkZK9500Connected,
    captureFingerprint,
    verifyFingerprints,
    generateSimulatedTemplate,
    initializeDevice,
    getSDKStatus
};
