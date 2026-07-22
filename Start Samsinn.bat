@echo off
rem Double-click launcher for Samsinn (local, free setup)
rem - Ensures Ollama is running in CPU mode
rem - Runs the Samsinn server in a minimized, self-restarting loop:
rem   if the server crashes it restarts within 3 seconds, and every run
rem   logs to %USERPROFILE%\.samsinn\server.log so crashes leave evidence
rem - Waits until the server answers before opening the browser

if "%~1"=="__serve" goto serve

set CUDA_VISIBLE_DEVICES=-1
set SAMSINN_SEED_MODEL=ollama:qwen2.5:7b
cd /d "%~dp0"

rem Start Ollama if it is not already running
tasklist /FI "IMAGENAME eq ollama.exe" 2>nul | find /I "ollama.exe" >nul
if errorlevel 1 (
    echo Starting Ollama in CPU mode...
    start "Ollama" /MIN cmd /c "ollama serve"
)

echo Starting Samsinn server (minimized window "Samsinn server")...
start "Samsinn server - close this window to stop" /MIN cmd /c ""%~f0" __serve"

echo Waiting for the server to come up...
set tries=0
:wait
set /a tries+=1
if %tries% gtr 60 (
    echo Server did not answer after 60 seconds.
    echo Check %USERPROFILE%\.samsinn\server.log for the error.
    pause
    exit /b 1
)
timeout /t 1 /nobreak >nul
curl -s -o nul http://localhost:3000/api/system/info
if errorlevel 1 goto wait

echo Server is up - opening http://localhost:3000
start "" http://localhost:3000
timeout /t 3 /nobreak >nul
exit /b 0

rem ==== server loop (runs inside the minimized "Samsinn server" window) ====
:serve
cd /d "%~dp0"
set CUDA_VISIBLE_DEVICES=-1
set SAMSINN_SEED_MODEL=ollama:qwen2.5:7b
set LOG=%USERPROFILE%\.samsinn\server.log
echo [%date% %time%] ==== launcher session start ==== > "%LOG%"
:loop
rem Refuse to fight another server for the port (double-launch guard)
netstat -ano | findstr ":3000" | findstr "LISTENING" >nul
if not errorlevel 1 (
    echo [%date% %time%] port 3000 already in use - another server is running; retrying in 15s >> "%LOG%"
    timeout /t 15 /nobreak >nul
    goto loop
)
echo [%date% %time%] starting server >> "%LOG%"
bun run start >> "%LOG%" 2>&1
echo [%date% %time%] server exited (code %errorlevel%) - restarting in 3s >> "%LOG%"
timeout /t 3 /nobreak >nul
goto loop
