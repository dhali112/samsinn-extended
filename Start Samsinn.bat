@echo off
rem Double-click launcher for Samsinn (local, free setup)
rem - Ensures Ollama is running in CPU mode (GTX 1060 driver is too old
rem   for the CUDA toolkit newer Ollama builds ship)
rem - Starts the Samsinn server in its own window
rem - Waits until the server actually answers before opening the browser
rem   (opening early showed a "can't connect" page that looked like a
rem   failed startup while the server was still booting)

set CUDA_VISIBLE_DEVICES=-1
rem Seed new sandboxes with the local model that actually works here
set SAMSINN_SEED_MODEL=ollama:qwen2.5:7b
cd /d "%~dp0"

rem Start Ollama if it is not already running
tasklist /FI "IMAGENAME eq ollama.exe" 2>nul | find /I "ollama.exe" >nul
if errorlevel 1 (
    echo Starting Ollama in CPU mode...
    start "Ollama" /MIN cmd /c "ollama serve"
)

rem Start the Samsinn server in its own window (close that window to stop it)
echo Starting Samsinn server...
start "Samsinn server - close this window to stop" cmd /c "bun run start"

echo Waiting for the server to come up...
set tries=0
:wait
set /a tries+=1
if %tries% gtr 60 (
    echo Server did not answer after 60 seconds - check the "Samsinn server" window for errors.
    pause
    exit /b 1
)
timeout /t 1 /nobreak >nul
curl -s -o nul http://localhost:3000/api/system/info
if errorlevel 1 goto wait

echo Server is up - opening http://localhost:3000
start "" http://localhost:3000
timeout /t 3 /nobreak >nul
