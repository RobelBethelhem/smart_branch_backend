/**
 * ZKCapture - ZK9500 Fingerprint Capture Console Application
 *
 * This console app interfaces with the ZKFinger SDK to provide
 * fingerprint capture, verification, and fast 1:N identification.
 *
 * Usage:
 *   ZKCapture.exe check                    - Check if scanner is connected
 *   ZKCapture.exe capture                  - Capture a fingerprint template
 *   ZKCapture.exe verify <t1> <t2>         - Verify two templates match (1:1)
 *   ZKCapture.exe identify <template> <db> - Fast 1:N identification against JSON database
 *
 * The 'identify' command uses ZK SDK's DBIdentify for fast matching:
 * - Loads all templates into SDK's internal indexed database
 * - Uses optimized matching algorithm (~50,000+ matches/second)
 * - Returns matched fingerprint ID (CIF) if found
 *
 * Output: JSON format to stdout
 */

using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Threading;
using libzkfpcsharp;

namespace ZKCapture
{
    // Structure for fingerprint database entries
    public class FingerprintEntry
    {
        public string? cif { get; set; }
        public string? template { get; set; }
        public string? finger_position { get; set; }
        public string? customer_name { get; set; }
    }

    public class FingerprintDatabase
    {
        public List<FingerprintEntry>? fingerprints { get; set; }
    }

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

        // Matching threshold (ZK SDK typically uses 50-70)
        private const int MATCH_THRESHOLD = 50;

        static void Main(string[] args)
        {
            if (args.Length == 0)
            {
                OutputJson(new { success = false, message = "Usage: ZKCapture.exe [check|capture|verify|identify]" });
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
                    case "verifyfile":
                        if (args.Length < 3)
                        {
                            OutputJson(new { success = false, message = "Usage: ZKCapture.exe verifyfile <template1_file> <template2_file>" });
                            return;
                        }
                        VerifyTemplatesFromFiles(args[1], args[2]);
                        break;
                    case "identify":
                        if (args.Length < 3)
                        {
                            OutputJson(new { success = false, message = "Usage: ZKCapture.exe identify <template> <database_json_file>" });
                            return;
                        }
                        IdentifyFingerprint(args[1], args[2]);
                        break;
                    case "identifyfile":
                        if (args.Length < 3)
                        {
                            OutputJson(new { success = false, message = "Usage: ZKCapture.exe identifyfile <template_file> <database_json_file>" });
                            return;
                        }
                        IdentifyFingerprintFromFile(args[1], args[2]);
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
                bool isMatch = score > MATCH_THRESHOLD;

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

        /// <summary>
        /// Verify two fingerprint templates from files (handles long Base64 strings)
        /// </summary>
        static void VerifyTemplatesFromFiles(string template1FilePath, string template2FilePath)
        {
            // Read templates from files
            if (!File.Exists(template1FilePath))
            {
                OutputJson(new { success = false, match = false, message = $"Template file 1 not found: {template1FilePath}" });
                return;
            }

            if (!File.Exists(template2FilePath))
            {
                OutputJson(new { success = false, match = false, message = $"Template file 2 not found: {template2FilePath}" });
                return;
            }

            string template1Base64 = File.ReadAllText(template1FilePath).Trim();
            string template2Base64 = File.ReadAllText(template2FilePath).Trim();

            // Use the existing verify logic
            VerifyTemplates(template1Base64, template2Base64);
        }

        /// <summary>
        /// Fast 1:N identification from file (handles long Base64 query templates)
        /// </summary>
        static void IdentifyFingerprintFromFile(string queryTemplateFilePath, string databaseFilePath)
        {
            // Read query template from file
            if (!File.Exists(queryTemplateFilePath))
            {
                OutputJson(new { success = false, found = false, message = $"Query template file not found: {queryTemplateFilePath}" });
                return;
            }

            string queryTemplateBase64 = File.ReadAllText(queryTemplateFilePath).Trim();

            // Use the existing identify logic
            IdentifyFingerprint(queryTemplateBase64, databaseFilePath);
        }

        /// <summary>
        /// Fast 1:N fingerprint identification using ZK SDK's optimized DBIdentify
        /// This loads all templates into the SDK's internal indexed database for fast matching
        /// </summary>
        static void IdentifyFingerprint(string queryTemplateBase64, string databaseFilePath)
        {
            var startTime = DateTime.Now;

            // Initialize SDK
            int ret = zkfp2.Init();
            if (ret != zkfperrdef.ZKFP_ERR_OK)
            {
                OutputJson(new { success = false, found = false, message = $"SDK init failed (error: {ret})" });
                return;
            }

            // Initialize DB for 1:N identification
            IntPtr dbHandle = zkfp2.DBInit();
            if (dbHandle == IntPtr.Zero)
            {
                zkfp2.Terminate();
                OutputJson(new { success = false, found = false, message = "Failed to initialize database" });
                return;
            }

            try
            {
                // Read database file
                if (!File.Exists(databaseFilePath))
                {
                    OutputJson(new { success = false, found = false, message = $"Database file not found: {databaseFilePath}" });
                    return;
                }

                string jsonContent = File.ReadAllText(databaseFilePath);
                var database = JsonSerializer.Deserialize<FingerprintDatabase>(jsonContent);

                if (database?.fingerprints == null || database.fingerprints.Count == 0)
                {
                    OutputJson(new { success = false, found = false, message = "No fingerprints in database" });
                    return;
                }

                // Convert query template
                byte[] queryBlob = zkfp2.Base64ToBlob(queryTemplateBase64);
                if (queryBlob == null)
                {
                    OutputJson(new { success = false, found = false, message = "Invalid query template format" });
                    return;
                }

                // Load all templates into SDK's internal database with indexed IDs
                // The SDK uses an optimized data structure for fast matching
                var cifMapping = new Dictionary<int, FingerprintEntry>();
                int fingerprintId = 1;
                int loadedCount = 0;

                foreach (var entry in database.fingerprints)
                {
                    if (string.IsNullOrEmpty(entry.template)) continue;

                    try
                    {
                        byte[] templateBlob = zkfp2.Base64ToBlob(entry.template);
                        if (templateBlob != null)
                        {
                            // Add template to internal indexed database
                            ret = zkfp2.DBAdd(dbHandle, fingerprintId, templateBlob);
                            if (ret == zkfperrdef.ZKFP_ERR_OK)
                            {
                                cifMapping[fingerprintId] = entry;
                                loadedCount++;
                            }
                            fingerprintId++;
                        }
                    }
                    catch
                    {
                        // Skip invalid templates
                        continue;
                    }
                }

                var loadTime = (DateTime.Now - startTime).TotalMilliseconds;

                if (loadedCount == 0)
                {
                    OutputJson(new { success = false, found = false, message = "No valid templates in database" });
                    return;
                }

                // Perform fast 1:N identification using SDK's optimized algorithm
                var matchStartTime = DateTime.Now;
                int matchedId = 0;
                int matchScore = 0;

                ret = zkfp2.DBIdentify(dbHandle, queryBlob, ref matchedId, ref matchScore);

                var matchTime = (DateTime.Now - matchStartTime).TotalMilliseconds;
                var totalTime = (DateTime.Now - startTime).TotalMilliseconds;

                if (ret == zkfperrdef.ZKFP_ERR_OK && matchedId > 0 && matchScore >= MATCH_THRESHOLD)
                {
                    // Found a match
                    var matchedEntry = cifMapping[matchedId];
                    OutputJson(new {
                        success = true,
                        found = true,
                        cif = matchedEntry.cif,
                        customer_name = matchedEntry.customer_name,
                        finger_position = matchedEntry.finger_position,
                        score = matchScore,
                        database_size = loadedCount,
                        load_time_ms = Math.Round(loadTime, 2),
                        match_time_ms = Math.Round(matchTime, 2),
                        total_time_ms = Math.Round(totalTime, 2),
                        message = $"Fingerprint identified! CIF: {matchedEntry.cif}"
                    });
                }
                else
                {
                    OutputJson(new {
                        success = true,
                        found = false,
                        database_size = loadedCount,
                        load_time_ms = Math.Round(loadTime, 2),
                        match_time_ms = Math.Round(matchTime, 2),
                        total_time_ms = Math.Round(totalTime, 2),
                        message = "No matching fingerprint found in database"
                    });
                }
            }
            finally
            {
                // Clear database and cleanup
                zkfp2.DBClear(dbHandle);
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
