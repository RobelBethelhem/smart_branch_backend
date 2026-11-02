/**
 * ZK9500 Fingerprint Scanner WebSocket Service
 *
 * This service provides a WebSocket bridge between the web application
 * and the ZK9500 fingerprint scanner.
 *
 * Prerequisites:
 * 1. Install ZK9500 drivers from ZKTeco
 * 2. Optionally install the ZKFinger SDK for production
 * 3. Run this service locally
 */

import { WebSocketServer } from 'ws';
import {
    checkZK9500Connected,
    captureFingerprint,
    verifyFingerprints,
    initializeDevice,
    getSDKStatus
} from './zkfinger.js';

const PORT = process.env.FINGERPRINT_PORT || 8089;

// Store connected clients
const clients = new Set();

// Scanner state
let scannerStatus = {
    connected: false,
    initialized: false,
    device: null,
    lastCheck: null
};

let isCapturing = false;

// Create WebSocket server
const wss = new WebSocketServer({
    port: PORT,
    clientTracking: true
});

console.log('='.repeat(50));
console.log('ZK9500 Fingerprint WebSocket Service');
console.log('='.repeat(50));
console.log(`WebSocket Server: ws://localhost:${PORT}`);

// Check SDK status
const sdkStatus = getSDKStatus();
console.log('');
console.log('SDK Status:', sdkStatus.message);
if (!sdkStatus.zkCaptureExists) {
    console.log('');
    console.log('To enable real fingerprint capture:');
    console.log('  1. Run build.bat to compile ZKCapture.exe');
    console.log('  2. Make sure ZK9500 driver is installed');
}
console.log('');
console.log('Waiting for connections...');
console.log('');

// Initial device check
checkDevice().then(status => {
    console.log('Initial scanner status:', status.connected ? 'CONNECTED' : 'NOT DETECTED');
    if (status.device) {
        console.log('Device:', status.device);
    }
});

wss.on('connection', (ws, req) => {
    const clientIP = req.socket.remoteAddress;
    console.log(`[${new Date().toISOString()}] Client connected from ${clientIP}`);
    clients.add(ws);

    // Send initial status
    ws.send(JSON.stringify({
        type: 'status',
        connected: scannerStatus.connected,
        message: scannerStatus.connected ? 'Scanner ready' : 'Checking scanner...'
    }));

    // Check scanner on new connection
    checkDevice().then(status => {
        ws.send(JSON.stringify({
            type: 'status',
            connected: status.connected,
            message: status.connected
                ? `ZK9500 Scanner ready (${status.method})`
                : 'Scanner not detected. Please connect ZK9500 and click Check.'
        }));
    });

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message.toString());
            console.log(`[${new Date().toISOString()}] Received:`, data.action);

            switch (data.action) {
                case 'check':
                    await handleCheck(ws);
                    break;
                case 'capture':
                    await handleCapture(ws);
                    break;
                case 'verify':
                    await handleVerify(ws, data.template1, data.template2);
                    break;
                default:
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Unknown action: ' + data.action
                    }));
            }
        } catch (error) {
            console.error('Error processing message:', error);
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Invalid message format'
            }));
        }
    });

    ws.on('close', () => {
        console.log(`[${new Date().toISOString()}] Client disconnected`);
        clients.delete(ws);
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error.message);
        clients.delete(ws);
    });
});

/**
 * Check device status
 */
async function checkDevice() {
    try {
        const status = await checkZK9500Connected();
        scannerStatus = {
            connected: status.connected,
            device: status.device,
            method: status.method,
            lastCheck: new Date()
        };
        return status;
    } catch (error) {
        console.error('Device check error:', error);
        scannerStatus.connected = false;
        return { connected: false, error: error.message };
    }
}

/**
 * Handle check scanner request
 */
async function handleCheck(ws) {
    try {
        console.log('Checking for ZK9500 scanner...');
        const status = await checkDevice();

        ws.send(JSON.stringify({
            type: 'status',
            connected: status.connected,
            device: status.device,
            message: status.connected
                ? `ZK9500 Scanner detected (${status.method})`
                : 'Scanner not detected. Please connect ZK9500 via USB.'
        }));

        console.log('Scanner check result:', status.connected ? 'FOUND' : 'NOT FOUND');

    } catch (error) {
        console.error('Check error:', error);
        ws.send(JSON.stringify({
            type: 'status',
            connected: false,
            message: 'Error checking scanner: ' + error.message
        }));
    }
}

/**
 * Handle fingerprint capture request
 */
async function handleCapture(ws) {
    if (isCapturing) {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Capture already in progress. Please wait.'
        }));
        return;
    }

    isCapturing = true;
    console.log('Starting fingerprint capture...');

    // Send capturing status
    ws.send(JSON.stringify({
        type: 'capturing',
        message: 'Place your finger on the scanner...'
    }));

    try {
        const result = await captureFingerprint(10000);

        if (result.success) {
            console.log('Fingerprint captured successfully', result.simulated ? '(simulated)' : '');

            ws.send(JSON.stringify({
                type: 'captured',
                success: true,
                template: result.template,
                simulated: result.simulated || false,
                message: result.simulated
                    ? 'Fingerprint captured (simulation mode - SDK not installed)'
                    : 'Fingerprint captured successfully'
            }));
        } else {
            ws.send(JSON.stringify({
                type: 'captured',
                success: false,
                message: result.message || 'Capture failed'
            }));
        }

    } catch (error) {
        console.error('Capture error:', error);
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Capture failed: ' + error.message
        }));
    } finally {
        isCapturing = false;
    }
}

/**
 * Handle fingerprint verification request
 */
async function handleVerify(ws, template1, template2) {
    if (!template1 || !template2) {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Two templates are required for verification'
        }));
        return;
    }

    try {
        console.log('Verifying fingerprints...');
        const result = await verifyFingerprints(template1, template2);

        ws.send(JSON.stringify({
            type: 'verified',
            match: result.match,
            score: result.score,
            simulated: result.simulated || false,
            message: result.match ? 'Fingerprints match!' : 'Fingerprints do not match'
        }));

        console.log('Verification result:', result.match ? 'MATCH' : 'NO MATCH', `(score: ${result.score})`);

    } catch (error) {
        console.error('Verification error:', error);
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Verification failed: ' + error.message
        }));
    }
}

/**
 * Broadcast message to all connected clients
 */
function broadcast(message) {
    const data = JSON.stringify(message);
    clients.forEach(client => {
        if (client.readyState === 1) { // WebSocket.OPEN
            client.send(data);
        }
    });
}

// Periodic scanner check (every 10 seconds)
setInterval(async () => {
    if (clients.size > 0) {
        const status = await checkDevice();
        // Only broadcast if status changed
        if (status.connected !== scannerStatus.connected) {
            broadcast({
                type: 'status',
                connected: status.connected,
                message: status.connected ? 'Scanner reconnected' : 'Scanner disconnected'
            });
        }
    }
}, 10000);

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down fingerprint service...');

    // Close all client connections
    clients.forEach(client => {
        client.close(1000, 'Server shutting down');
    });

    wss.close(() => {
        console.log('Service stopped');
        process.exit(0);
    });
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled rejection at:', promise, 'reason:', reason);
});

console.log('');
console.log('Make sure ZK9500 is connected via USB');
console.log('Press Ctrl+C to stop the service');
console.log('='.repeat(50));
