@echo off
echo ============================================
echo ZK9500 Fingerprint Capture - Build Script
echo ============================================
echo.

REM Check if .NET SDK is installed
dotnet --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: .NET SDK not found!
    echo Please install .NET 6.0 SDK from: https://dotnet.microsoft.com/download
    pause
    exit /b 1
)

echo .NET SDK found:
dotnet --version
echo.

REM Navigate to ZKCapture directory
cd /d "%~dp0ZKCapture"

REM Create lib directory if not exists
if not exist "lib" mkdir "lib"

REM Copy SDK DLL
echo Copying ZKFinger SDK DLL...
set SDK_PATH=C:\Users\MSIGE79\Downloads\fingerprintSDK\zkfinger_sdk_v10.0-windows-lite-zk9500\ZKFinger SDK V10.0-Windows-Lite\C#\lib\x64\libzkfpcsharp.dll

if exist "%SDK_PATH%" (
    copy "%SDK_PATH%" "lib\" /Y
    echo SDK DLL copied to lib folder
) else (
    echo WARNING: SDK DLL not found at expected path
    echo Please manually copy libzkfpcsharp.dll to: %~dp0ZKCapture\lib\
)

echo.
echo Building ZKCapture.exe...
dotnet build -c Release

if errorlevel 1 (
    echo.
    echo BUILD FAILED!
    pause
    exit /b 1
)

echo.
echo ============================================
echo BUILD SUCCESSFUL!
echo ============================================
echo.
echo Output: %~dp0ZKCapture\bin\Release\net6.0-windows\ZKCapture.exe
echo.

REM Copy SDK DLL to output directory (needed at runtime)
if exist "%SDK_PATH%" (
    copy "%SDK_PATH%" "bin\Release\net6.0-windows\" /Y
    echo SDK DLL copied to output directory
)

REM Also copy to parent fingerprint directory for easy access
copy "bin\Release\net6.0-windows\ZKCapture.exe" "%~dp0" /Y
copy "bin\Release\net6.0-windows\libzkfpcsharp.dll" "%~dp0" /Y 2>nul

echo.
echo ZKCapture.exe is now ready in: %~dp0
echo.
echo Test commands:
echo   ZKCapture.exe check    - Check scanner connection
echo   ZKCapture.exe capture  - Capture fingerprint
echo.
pause
