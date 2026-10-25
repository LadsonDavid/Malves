@echo off
rem Starts malves with the Node.js that came in this folder, so Node doesn't need installing.
rem Settings (your keys, your name) are read from %MALVES_HOME%\.env, or %USERPROFILE%\.malves\.env.
setlocal
if defined MALVES_HOME (set "MALVES_ENV=%MALVES_HOME%\.env") else (set "MALVES_ENV=%USERPROFILE%\.malves\.env")
if exist "%MALVES_ENV%" goto withenv
"%~dp0node.exe" "%~dp0dist\main.js" %*
exit /b %ERRORLEVEL%
:withenv
"%~dp0node.exe" "--env-file=%MALVES_ENV%" "%~dp0dist\main.js" %*
exit /b %ERRORLEVEL%
