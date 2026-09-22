@echo off
REM ═══════════════════════════════════════════════════════════════
REM  SFX Manager — one-click installer for Windows
REM  Installs the panel for After Effects & enables CEP debug mode
REM ═══════════════════════════════════════════════════════════════
setlocal
set EXT_ID=com.nadim.sfxmanager
set SRC=%~dp0SFXManager
set DEST=%APPDATA%\Adobe\CEP\extensions\%EXT_ID%

echo ────────────────────────────────────────
echo   SFX Manager — Windows installer
echo ────────────────────────────────────────

if not exist "%SRC%" (
  echo [X] Could not find the SFXManager folder next to this script.
  pause
  exit /b 1
)

echo ^> Copying panel to:
echo   %DEST%
if exist "%DEST%" rmdir /s /q "%DEST%"
mkdir "%DEST%" 2>nul
xcopy "%SRC%\*" "%DEST%\" /E /I /Y /Q >nul

echo ^> Enabling unsigned CEP extensions (PlayerDebugMode)...
reg add "HKEY_CURRENT_USER\Software\Adobe\CSXS.7"  /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>&1
reg add "HKEY_CURRENT_USER\Software\Adobe\CSXS.8"  /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>&1
reg add "HKEY_CURRENT_USER\Software\Adobe\CSXS.9"  /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>&1
reg add "HKEY_CURRENT_USER\Software\Adobe\CSXS.10" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>&1
reg add "HKEY_CURRENT_USER\Software\Adobe\CSXS.11" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>&1
reg add "HKEY_CURRENT_USER\Software\Adobe\CSXS.12" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>&1

echo.
echo  [OK] Installed successfully.
echo.
echo   1. Quit After Effects completely.
echo   2. Reopen After Effects.
echo   3. Open the panel:  Window ^> SFX Manager
echo.
pause
