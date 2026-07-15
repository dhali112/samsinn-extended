@echo off
rem Double-click launcher for Samsinn (local, free setup)
rem - Ensures Ollama is running in CPU mode (GTX 1060 driver is too old
rem   for the CUDA toolkit newer Ollama builds ship)
rem - Starts the Samsinn server and opens the app in your browser

set CUDA_VISIBLE_DEVICES=-1
cd /d "%~dp0"

rem Start Ollama if it is not already running
tasklist /FI "IMAGENAME eq ollama.exe" 2>nul | find /I "ollama.exe" >nul
if errorlevel 1 (
    echo Starting Ollama in CPU mode...
    start "Ollama" /MIN cmd /c "ollama serve"
    timeout /t 5 /nobreak >nul
)

echo Opening the app at http://localhost:3000 ...
start "" http://localhost:3000

echo Starting Samsinn... close this window to stop the app.
bun run start
