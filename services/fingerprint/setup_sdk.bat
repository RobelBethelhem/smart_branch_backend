@echo off
echo Setting up ZKFinger SDK...

REM Create lib directory
if not exist "ZKCapture\lib" mkdir "ZKCapture\lib"

REM Copy SDK DLL (x64)
copy "C:\Users\MSIGE79\Downloads\fingerprintSDK\zkfinger_sdk_v10.0-windows-lite-zk9500\ZKFinger SDK V10.0-Windows-Lite\C#\lib\x64\libzkfpcsharp.dll" "ZKCapture\lib\" /Y

REM Also copy to output directory for runtime
if not exist "ZKCapture\bin\Release\net6.0-windows\win-x64" mkdir "ZKCapture\bin\Release\net6.0-windows\win-x64"
copy "C:\Users\MSIGE79\Downloads\fingerprintSDK\zkfinger_sdk_v10.0-windows-lite-zk9500\ZKFinger SDK V10.0-Windows-Lite\C#\lib\x64\libzkfpcsharp.dll" "ZKCapture\bin\Release\net6.0-windows\win-x64\" /Y

echo SDK files copied successfully!
echo.
echo Now building ZKCapture...
cd ZKCapture
dotnet build -c Release

echo.
echo Build complete! You can find ZKCapture.exe in:
echo   ZKCapture\bin\Release\net6.0-windows\win-x64\
echo.
pause
