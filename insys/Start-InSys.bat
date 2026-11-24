@echo off
setlocal EnableExtensions
title InSys - Internal Systems
pushd "%~dp0"

rem ---------------------------------------------------------------------
rem  InSys launcher for Windows.
rem  Finds Python 3.9 or newer (offering to install it if it is missing),
rem  then starts InSys. Any options are passed straight to insys.py.
rem ---------------------------------------------------------------------

set "PYEXE="
set "PYARGS="
call :find_python
if defined PYEXE goto run

echo.
echo  InSys needs Python 3 (free, from python.org), which was not found
echo  on this computer.
echo.
where winget >nul 2>&1
if errorlevel 1 goto manual
echo  Windows can install it for you now. This takes a minute or two and
echo  only needs to be done once.
echo.
choice /C YN /N /M "  Install Python now? [Y/N] "
if errorlevel 2 goto manual
echo.
winget install -e --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements
call :find_python
if defined PYEXE goto run
echo.
echo  Python was installed but this window cannot see it yet.
echo  Please close this window and double-click Start-InSys.bat again.
goto finish

:manual
echo  To install Python yourself:
echo.
echo    1. Open  https://www.python.org/downloads/windows/
echo    2. Download and run the "Windows installer (64-bit)".
echo    3. Tick "Add python.exe to PATH", then click "Install Now".
echo    4. Double-click Start-InSys.bat again.
goto finish

:run
if "%PYEXE%"=="py" goto run_launcher
"%PYEXE%" "%~dp0insys.py" %*
goto finish

:run_launcher
py -3 "%~dp0insys.py" %*
goto finish

:finish
echo.
pause
popd
endlocal
exit /b 0

rem ---------------------------------------------------------------------
rem  Sets PYEXE to a working Python 3.9+ ("py" means the py launcher).
rem ---------------------------------------------------------------------
:find_python
set "PYEXE="
py -3 -c "import sys, sqlite3; sys.exit(0 if sys.version_info >= (3, 9) else 1)" >nul 2>&1
if not errorlevel 1 set "PYEXE=py"
if defined PYEXE goto :eof
python -c "import sys, sqlite3; sys.exit(0 if sys.version_info >= (3, 9) else 1)" >nul 2>&1
if not errorlevel 1 set "PYEXE=python"
if defined PYEXE goto :eof
for /d %%D in ("%LocalAppData%\Programs\Python\Python3*") do call :try_python "%%~fD\python.exe"
for /d %%D in ("%ProgramFiles%\Python3*") do call :try_python "%%~fD\python.exe"
goto :eof

:try_python
if defined PYEXE goto :eof
if not exist "%~1" goto :eof
"%~1" -c "import sys, sqlite3; sys.exit(0 if sys.version_info >= (3, 9) else 1)" >nul 2>&1
if errorlevel 1 goto :eof
set "PYEXE=%~1"
goto :eof
