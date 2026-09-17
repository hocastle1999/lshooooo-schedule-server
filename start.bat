@echo off
cd /d "%~dp0"

echo ============================================
echo  Setting up and starting the schedule server
echo ============================================
echo.
echo [1/2] Installing packages (first run only, may take a bit)...
call npm install
if errorlevel 1 (
  echo.
  echo npm install failed. Please make sure Node.js is installed.
  echo https://nodejs.org
  pause
  exit /b 1
)

echo.
echo [2/2] Starting the server.
echo  - Open http://localhost:3000 in a browser to check it locally.
echo  - Your ngrok tunnel is already pointed at port 3000, so once this
echo    server is running, the public ngrok address will work too.
echo  - Closing this window stops the server.
echo.
node server.js

pause
