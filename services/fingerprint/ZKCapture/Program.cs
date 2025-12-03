/**
 * ZKCapture - ZK9500 Fingerprint Capture Console Application
 *
 * This console app interfaces with the ZKFinger SDK to provide
 * fingerprint capture and verification functionality.
 *
 * Usage:
 *   ZKCapture.exe check              - Check if scanner is connected
 *   ZKCapture.exe capture            - Capture a fingerprint template
 *   ZKCapture.exe verify <t1> <t2>   - Verify two templates match
 *
 * Output: JSON format to stdout
 */

using System;
using System.Text;
using System.Text.Json;
using System.Threading;
using libzkfpcsharp;

namespace ZKCapture
{
    class Program
    {
        private static IntPtr mDevHandle = IntPtr.Zero;
        private static IntPtr mDBHandle = IntPtr.Zero;
        private static int mfpWidth = 0;
        private static int mfpHeight = 0;
        private static byte[]? FPBuffer;
        private static byte[] CapTmp = new byte[2048];
        private static int cbCapTmp = 2048;
        private static bool captured = false;
        private static int captureResult = -1;

        static void Main(string[] args)
        {
            if (args.Length == 0)
            {
                OutputJson(new { success = false, message = "Usage: ZKCapture.exe [check|capture|verify]" });
                return;
            }

            string command = args[0].ToLower();

            try
            {
                switch (command)
                {
                    case "check":
                        CheckScanner();
                        break;
                    case "capture":
                        CaptureFingerprint();
                        break;
                    case "verify":
                        if (args.Length < 3)
                        {
                            OutputJson(new { success = false, message = "Usage: ZKCapture.exe verify <template1> <template2>" });
                            return;
                        }
                        VerifyTemplates(args[1], args[2]);
                        break;
                    default:
                        OutputJson(new { success = false, message = $"Unknown command: {command}" });
                        break;
                }
            }
            catch (Exception ex)
            {
                OutputJson(new { success = false, message = $"Error: {ex.Message}" });
            }
        }

        static void CheckScanner()
        {
            int ret = zkfp2.Init();
            if (ret != zkfperrdef.ZKFP_ERR_OK)
            {
                OutputJson(new {
                    success = false,
                    connected = false,
                    message = $"SDK initialization failed (error: {ret})"
                });
                return;
            }

            int deviceCount = zkfp2.GetDeviceCount();
            zkfp2.Terminate();

            OutputJson(new {
                success = true,
                connected = deviceCount > 0,
                deviceCount = deviceCount,
                message = deviceCount > 0
                    ? $"Found {deviceCount} fingerprint scanner(s)"
                    : "No fingerprint scanner detected"
            });
        }

        static void CaptureFingerprint()
        {
            // Initialize SDK
            int ret = zkfp2.Init();
            if (ret != zkfperrdef.ZKFP_ERR_OK)
            {
                OutputJson(new { success = false, message = $"SDK init failed (error: {ret})" });
                return;
            }

            // Check device count
            int deviceCount = zkfp2.GetDeviceCount();
            if (deviceCount <= 0)
            {
                zkfp2.Terminate();
                OutputJson(new { success = false, message = "No fingerprint scanner connected" });
                return;
            }

            // Open device
            mDevHandle = zkfp2.OpenDevice(0);
            if (mDevHandle == IntPtr.Zero)
            {
                zkfp2.Terminate();
                OutputJson(new { success = false, message = "Failed to open fingerprint scanner" });
                return;
            }

            // Initialize DB for template operations
            mDBHandle = zkfp2.DBInit();
            if (mDBHandle == IntPtr.Zero)
            {
                zkfp2.CloseDevice(mDevHandle);
                zkfp2.Terminate();
                OutputJson(new { success = false, message = "Failed to initialize fingerprint database" });
                return;
            }

            // Get image dimensions
            byte[] paramValue = new byte[4];
            int size = 4;
            zkfp2.GetParameters(mDevHandle, 1, paramValue, ref size);
            zkfp2.ByteArray2Int(paramValue, ref mfpWidth);

            size = 4;
            zkfp2.GetParameters(mDevHandle, 2, paramValue, ref size);
            zkfp2.ByteArray2Int(paramValue, ref mfpHeight);

            FPBuffer = new byte[mfpWidth * mfpHeight];

            // Capture fingerprint with timeout
            captured = false;
            captureResult = -1;

            int timeout = 15000; // 15 seconds timeout
            int elapsed = 0;
            int interval = 100;

            while (!captured && elapsed < timeout)
            {
                cbCapTmp = 2048;
                ret = zkfp2.AcquireFingerprint(mDevHandle, FPBuffer, CapTmp, ref cbCapTmp);

                if (ret == zkfperrdef.ZKFP_ERR_OK)
                {
                    captured = true;
                    captureResult = ret;
                    break;
                }

                Thread.Sleep(interval);
                elapsed += interval;
            }

            // Cleanup
            zkfp2.DBFree(mDBHandle);
            zkfp2.CloseDevice(mDevHandle);
            zkfp2.Terminate();

            if (captured)
            {
                // Convert template to Base64
                string base64Template = zkfp2.BlobToBase64(CapTmp, cbCapTmp);

                OutputJson(new {
                    success = true,
                    template = base64Template,
                    templateSize = cbCapTmp,
                    imageWidth = mfpWidth,
                    imageHeight = mfpHeight,
                    message = "Fingerprint captured successfully"
                });
            }
            else
            {
                OutputJson(new {
                    success = false,
                    message = elapsed >= timeout
                        ? "Capture timeout - no finger detected"
                        : $"Capture failed (error: {captureResult})"
                });
            }
        }

        static void VerifyTemplates(string template1Base64, string template2Base64)
        {
            // Initialize SDK
            int ret = zkfp2.Init();
            if (ret != zkfperrdef.ZKFP_ERR_OK)
            {
                OutputJson(new { success = false, match = false, message = $"SDK init failed (error: {ret})" });
                return;
            }

            // Initialize DB for matching
            IntPtr dbHandle = zkfp2.DBInit();
            if (dbHandle == IntPtr.Zero)
            {
                zkfp2.Terminate();
                OutputJson(new { success = false, match = false, message = "Failed to initialize database" });
                return;
            }

            try
            {
                // Convert Base64 to byte arrays
                byte[] blob1 = zkfp2.Base64ToBlob(template1Base64);
                byte[] blob2 = zkfp2.Base64ToBlob(template2Base64);

                if (blob1 == null || blob2 == null)
                {
                    OutputJson(new { success = false, match = false, message = "Invalid template format" });
                    return;
                }

                // Match templates
                int score = zkfp2.DBMatch(dbHandle, blob1, blob2);

                // Score > 0 means match, typically threshold is around 50
                bool isMatch = score > 0;

                OutputJson(new {
                    success = true,
                    match = isMatch,
                    score = score,
                    message = isMatch ? "Fingerprints match" : "Fingerprints do not match"
                });
            }
            finally
            {
                zkfp2.DBFree(dbHandle);
                zkfp2.Terminate();
            }
        }

        static void OutputJson(object data)
        {
            var options = new JsonSerializerOptions
            {
                WriteIndented = false,
                PropertyNamingPolicy = JsonNamingPolicy.CamelCase
            };
            Console.WriteLine(JsonSerializer.Serialize(data, options));
        }
    }
}
