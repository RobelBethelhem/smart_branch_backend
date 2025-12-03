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

        /// <summary>
        /// Check if a template is a simulated template (JSON-based, not real ZK template)
        /// </summary>
        static bool IsSimulatedTemplate(string base64Template, out string? decodedJson)
        {
            decodedJson = null;
            if (string.IsNullOrEmpty(base64Template)) return false;

            try
            {
                // Try to decode as Base64 and check if it's JSON with simulation marker
                string cleaned = CleanBase64(base64Template);
                byte[] bytes = Convert.FromBase64String(cleaned);
                string decoded = Encoding.UTF8.GetString(bytes);

                // Check if it's a JSON object with simulation marker
                if (decoded.Contains("ZK9500_SIMULATED") || decoded.Contains("\"type\"") && decoded.Contains("\"version\""))
                {
                    decodedJson = decoded;
                    return true;
                }
            }
            catch
            {
                // Not valid Base64 or not JSON - might be a real template
            }

            return false;
        }

        /// <summary>
        /// Clean and normalize Base64 string for proper parsing
        /// </summary>
        static string CleanBase64(string base64)
        {
            if (string.IsNullOrEmpty(base64)) return base64;

            // Remove whitespace, newlines, carriage returns
            string cleaned = base64.Trim()
                .Replace("\r", "")
                .Replace("\n", "")
                .Replace(" ", "")
                .Replace("\t", "");

            // Handle URL-safe Base64 (convert - to + and _ to /)
            cleaned = cleaned.Replace('-', '+').Replace('_', '/');

            // Fix padding if needed
            int mod = cleaned.Length % 4;
            if (mod > 0)
            {
                cleaned += new string('=', 4 - mod);
            }

            return cleaned;
        }

        /// <summary>
        /// Convert Base64 to byte array with multiple fallback methods
        /// </summary>
        static byte[]? SafeBase64ToBlob(string base64, out string error)
        {
            error = "";
            if (string.IsNullOrEmpty(base64))
            {
                error = "Template is empty";
                return null;
            }

            string cleaned = CleanBase64(base64);

            // Try ZK SDK's method first
            try
            {
                byte[] blob = zkfp2.Base64ToBlob(cleaned);
                if (blob != null && blob.Length > 0)
                {
                    return blob;
                }
            }
            catch { }

            // Fallback to .NET's Base64 decoder
            try
            {
                byte[] blob = Convert.FromBase64String(cleaned);
                if (blob != null && blob.Length > 0)
                {
                    return blob;
                }
            }
            catch (FormatException ex)
            {
                error = $"Base64 decode failed: {ex.Message}";
            }

            // Try original string without cleaning
            try
            {
                byte[] blob = zkfp2.Base64ToBlob(base64);
                if (blob != null && blob.Length > 0)
                {
                    return blob;
                }
            }
            catch { }

            error = $"Could not decode template (length: {base64.Length}, first 50 chars: {base64.Substring(0, Math.Min(50, base64.Length))})";
            return null;
        }

        static void VerifyTemplates(string template1Base64, string template2Base64)
        {
            // Check for simulated templates first
            string? json1, json2;
            bool isSimulated1 = IsSimulatedTemplate(template1Base64, out json1);
            bool isSimulated2 = IsSimulatedTemplate(template2Base64, out json2);

            // Handle simulated templates
            if (isSimulated1 || isSimulated2)
            {
                if (isSimulated1 && isSimulated2)
                {
                    // Both are simulated - compare the raw Base64 strings
                    bool match = template1Base64.Trim() == template2Base64.Trim();
                    OutputJson(new {
                        success = true,
                        match = match,
                        score = match ? 100 : 0,
                        simulated = true,
                        message = match ? "Simulated templates match" : "Simulated templates do not match"
                    });
                    return;
                }
                else
                {
                    // One is simulated, one is real - cannot match
                    OutputJson(new {
                        success = true,
                        match = false,
                        score = 0,
                        simulated = true,
                        message = "Cannot compare simulated template with real template",
                        template1Simulated = isSimulated1,
                        template2Simulated = isSimulated2
                    });
                    return;
                }
            }

            // Both are real ZK templates - use SDK matching
            // Initialize SDK - try Init() but continue even if it fails (for DB operations without device)
            int ret = zkfp2.Init();
            bool sdkInitialized = (ret == zkfperrdef.ZKFP_ERR_OK);

            // Initialize DB for matching - this should work even without device
            IntPtr dbHandle = zkfp2.DBInit();
            if (dbHandle == IntPtr.Zero)
            {
                if (sdkInitialized) zkfp2.Terminate();
                OutputJson(new { success = false, match = false, message = "Failed to initialize fingerprint matching database" });
                return;
            }

            try
            {
                // Convert Base64 to byte arrays with robust parsing
                string error1, error2;
                byte[]? blob1 = SafeBase64ToBlob(template1Base64, out error1);
                byte[]? blob2 = SafeBase64ToBlob(template2Base64, out error2);

                if (blob1 == null || blob1.Length == 0)
                {
                    OutputJson(new {
                        success = false,
                        match = false,
                        message = $"Invalid template 1: {error1}",
                        template1Length = template1Base64?.Length ?? 0
                    });
                    return;
                }

                if (blob2 == null || blob2.Length == 0)
                {
                    OutputJson(new {
                        success = false,
                        match = false,
                        message = $"Invalid template 2: {error2}",
                        template2Length = template2Base64?.Length ?? 0
                    });
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
                    template1Size = blob1.Length,
                    template2Size = blob2.Length,
                    simulated = false,
                    message = isMatch ? "Fingerprints match" : "Fingerprints do not match"
                });
            }
            finally
            {
                zkfp2.DBFree(dbHandle);
                if (sdkInitialized) zkfp2.Terminate();
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
        /// Also handles simulated templates with direct string comparison
        /// </summary>
        static void IdentifyFingerprint(string queryTemplateBase64, string databaseFilePath)
        {
            var startTime = DateTime.Now;

            // Read database file first
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

            // Check if query template is simulated
            string? queryJson;
            bool isQuerySimulated = IsSimulatedTemplate(queryTemplateBase64, out queryJson);

            if (isQuerySimulated)
            {
                // Handle simulated template - direct string comparison
                var matchTime = DateTime.Now;
                string queryClean = queryTemplateBase64.Trim();

                foreach (var entry in database.fingerprints)
                {
                    if (string.IsNullOrEmpty(entry.template)) continue;

                    if (entry.template.Trim() == queryClean)
                    {
                        var totalTime = (DateTime.Now - startTime).TotalMilliseconds;
                        OutputJson(new {
                            success = true,
                            found = true,
                            cif = entry.cif,
                            customer_name = entry.customer_name,
                            finger_position = entry.finger_position,
                            score = 100,
                            database_size = database.fingerprints.Count,
                            simulated = true,
                            total_time_ms = Math.Round(totalTime, 2),
                            message = $"Simulated fingerprint matched! CIF: {entry.cif}"
                        });
                        return;
                    }
                }

                var totalTimeNoMatch = (DateTime.Now - startTime).TotalMilliseconds;
                OutputJson(new {
                    success = true,
                    found = false,
                    database_size = database.fingerprints.Count,
                    simulated = true,
                    total_time_ms = Math.Round(totalTimeNoMatch, 2),
                    message = "No matching simulated fingerprint found in database"
                });
                return;
            }

            // Real template - use SDK matching
            // Initialize SDK - try Init() but continue even if it fails (for DB operations without device)
            int ret = zkfp2.Init();
            bool sdkInitialized = (ret == zkfperrdef.ZKFP_ERR_OK);

            // Initialize DB for 1:N identification
            IntPtr dbHandle = zkfp2.DBInit();
            if (dbHandle == IntPtr.Zero)
            {
                if (sdkInitialized) zkfp2.Terminate();
                OutputJson(new { success = false, found = false, message = "Failed to initialize fingerprint matching database" });
                return;
            }

            try
            {
                // Convert query template with robust parsing
                string queryError;
                byte[]? queryBlob = SafeBase64ToBlob(queryTemplateBase64, out queryError);
                if (queryBlob == null || queryBlob.Length == 0)
                {
                    OutputJson(new {
                        success = false,
                        found = false,
                        message = $"Invalid query template: {queryError}",
                        queryTemplateLength = queryTemplateBase64?.Length ?? 0
                    });
                    return;
                }

                // Load all templates into SDK's internal database with indexed IDs
                // The SDK uses an optimized data structure for fast matching
                var cifMapping = new Dictionary<int, FingerprintEntry>();
                int fingerprintId = 1;
                int loadedCount = 0;
                int skippedCount = 0;

                foreach (var entry in database.fingerprints)
                {
                    if (string.IsNullOrEmpty(entry.template)) continue;

                    // Skip simulated templates when doing real SDK matching
                    string? simJson;
                    if (IsSimulatedTemplate(entry.template, out simJson))
                    {
                        skippedCount++;
                        continue;
                    }

                    try
                    {
                        string templateError;
                        byte[]? templateBlob = SafeBase64ToBlob(entry.template, out templateError);
                        if (templateBlob != null && templateBlob.Length > 0)
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
                        else
                        {
                            skippedCount++;
                        }
                    }
                    catch
                    {
                        // Skip invalid templates
                        skippedCount++;
                        continue;
                    }
                }

                var loadTime = (DateTime.Now - startTime).TotalMilliseconds;

                if (loadedCount == 0)
                {
                    OutputJson(new {
                        success = false,
                        found = false,
                        message = $"No valid real templates in database (total: {database.fingerprints.Count}, skipped: {skippedCount})",
                        skippedCount = skippedCount
                    });
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
                // Only terminate if we successfully initialized
                // Note: sdkInitialized is not in scope here, so we always try to terminate
                // This is safe as Terminate() handles the case where Init() wasn't called
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
