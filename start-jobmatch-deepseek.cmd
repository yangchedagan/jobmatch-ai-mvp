@echo off
setlocal
cd /d "%~dp0"

set "PORT=5180"
set "DEEPSEEK_MODEL=deepseek-v4-pro"
set "DEEPSEEK_BASE_URL=https://api.deepseek.com"
set "DEEPSEEK_THINKING_MODE=disabled"
set "DEEPSEEK_JSON_RETRIES=3"

echo Starting JobMatch AI MVP with DeepSeek V4 analysis...
echo.

if not defined DEEPSEEK_API_KEY (
  for /f "usebackq delims=" %%A in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$key = Read-Host 'Enter DeepSeek API Key' -AsSecureString; $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($key); try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }"`) do set "DEEPSEEK_API_KEY=%%A"
)

if not defined DEEPSEEK_API_KEY (
  echo.
  echo No DeepSeek API key entered. The app will start with rule-based fallback analysis.
  echo You can close this window and run the script again to enter a key.
  echo.
) else (
  echo.
  echo DeepSeek API key loaded for this session.
  echo Model: %DEEPSEEK_MODEL%
  echo.
)

echo Local URL: http://localhost:%PORT%
echo If %PORT% is busy, the server will automatically try the next port.
echo.

"C:\Program Files\nodejs\node.exe" server.js
pause
