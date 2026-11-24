@echo off
rem Gives the administrator account a new temporary password.
rem Use this if the administrator password has been forgotten.
call "%~dp0Start-InSys.bat" --reset-admin
