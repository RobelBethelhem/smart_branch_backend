# ZK9500 Fingerprint Scanner Integration

This service provides WebSocket bridge between the web application and ZK9500 USB fingerprint scanner using the official ZKFinger SDK.

## Prerequisites

### 1. Install .NET 6.0 SDK
Download and install from: https://dotnet.microsoft.com/download/dotnet/6.0

Verify installation:
```bash
dotnet --version
```

### 2. Install ZK9500 Driver
1. Run `setup.exe` from your ZKFinger SDK folder:
   ```
   C:\Users\MSIGE79\Downloads\fingerprintSDK\zkfinger_sdk_v10.0-windows-lite-zk9500\ZKFinger SDK V10.0-Windows-Lite\setup.exe
   ```
2. Restart your computer after installation
3. Plug in the ZK9500 scanner via USB

### 3. Verify Scanner Connection
1. Open Device Manager (Win + X → Device Manager)
2. Look for "ZK9500" under "Biometric devices" or "Universal Serial Bus devices"
3. If there's a yellow warning icon, reinstall the driver

## Quick Start

### Step 1: Build ZKCapture.exe
```bash
cd D:\smart_branch_backend\services\fingerprint
build.bat
```

This will:
- Copy the SDK DLL (libzkfpcsharp.dll) from your SDK folder
- Compile ZKCapture.exe using .NET
- Place the files in the fingerprint service directory

### Step 2: Install Node.js Dependencies
```bash
npm install
```

### Step 3: Start the Fingerprint Service
```bash
npm start
```

You should see:
```
==================================================
ZK9500 Fingerprint WebSocket Service
==================================================
WebSocket Server: ws://localhost:8089

SDK Status: ZKCapture.exe found - using real SDK

Waiting for connections...

Initial scanner status: CONNECTED
```

## Architecture

```
┌─────────────────┐     WebSocket      ┌────────────────────┐
│  React Frontend │ ←─────────────────→│ Fingerprint Service │
│  (port 4000)    │    (port 8089)     │ (Node.js)          │
└─────────────────┘                    └─────────┬──────────┘
                                                 │
                                                 │ exec()
                                                 ↓
                                       ┌────────────────────┐
                                       │  ZKCapture.exe     │
                                       │  (C# / .NET 6.0)   │
                                       └─────────┬──────────┘
                                                 │
                                                 │ libzkfpcsharp.dll
                                                 ↓
                                       ┌────────────────────┐     USB
                                       │  ZKFinger SDK      │ ←─────────→ ZK9500
                                       │  (Native DLL)      │
                                       └────────────────────┘
```

## Files Structure

```
services/fingerprint/
├── fingerprintService.js    # WebSocket server (Node.js)
├── zkfinger.js              # SDK integration module
├── package.json             # Node.js dependencies
├── build.bat                # Build script for ZKCapture.exe
├── ZKCapture.exe           # Compiled helper (after build)
├── libzkfpcsharp.dll       # SDK DLL (copied by build.bat)
├── ZKCapture/              # C# source code
│   ├── ZKCapture.csproj
│   ├── Program.cs
│   └── lib/
│       └── libzkfpcsharp.dll
└── README.md
```

## WebSocket API

### Check Scanner Status
```json
{ "action": "check" }
```
Response:
```json
{
  "type": "status",
  "connected": true,
  "message": "ZK9500 Scanner detected (sdk)"
}
```

### Capture Fingerprint
```json
{ "action": "capture" }
```
Response (capturing):
```json
{
  "type": "capturing",
  "message": "Place your finger on the scanner..."
}
```
Response (success):
```json
{
  "type": "captured",
  "success": true,
  "template": "base64_encoded_template_string",
  "simulated": false,
  "message": "Fingerprint captured successfully"
}
```

### Verify Fingerprints
```json
{
  "action": "verify",
  "template1": "base64_template_1",
  "template2": "base64_template_2"
}
```
Response:
```json
{
  "type": "verified",
  "match": true,
  "score": 85,
  "simulated": false,
  "message": "Fingerprints match!"
}
```

## ZKCapture.exe Commands

You can also test ZKCapture.exe directly:

```bash
# Check scanner connection
ZKCapture.exe check

# Capture fingerprint (place finger on scanner within 15 seconds)
ZKCapture.exe capture

# Verify two templates
ZKCapture.exe verify "base64_template1" "base64_template2"
```

## Simulation Mode

If ZKCapture.exe is not built or the SDK is not installed, the service runs in **simulation mode**:
- Scanner detection uses Windows WMI
- Capture generates simulated templates (marked with `simulated: true`)
- Full workflow can be tested without real hardware

## Troubleshooting

### "SDK initialization failed"
1. Make sure ZK9500 driver is installed (run setup.exe from SDK folder)
2. Restart your computer
3. Check Device Manager for the scanner

### "No fingerprint scanner connected"
1. Unplug and replug the USB cable
2. Try a different USB port
3. Check if the scanner's LED is on

### "ZKCapture.exe not found"
1. Run `build.bat` to compile
2. Make sure .NET 6.0 SDK is installed
3. Check build output for errors

### ".NET SDK not found"
Download from: https://dotnet.microsoft.com/download/dotnet/6.0

### "libzkfpcsharp.dll not found"
1. Make sure the SDK DLL exists at:
   ```
   C:\Users\MSIGE79\Downloads\fingerprintSDK\zkfinger_sdk_v10.0-windows-lite-zk9500\ZKFinger SDK V10.0-Windows-Lite\C#\lib\x64\libzkfpcsharp.dll
   ```
2. If the path is different, update `build.bat` with the correct path
3. Manually copy the DLL to the fingerprint service directory

### WebSocket Connection Failed
1. Check if the service is running (`npm start`)
2. Check firewall settings (allow port 8089)
3. Check browser console for errors

## Security Notes

- This service runs locally only (localhost)
- Fingerprint templates are base64 encoded
- For production, consider adding TLS/SSL to WebSocket connection
- Template matching uses the official ZKFinger SDK algorithm
