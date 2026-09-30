; MockInterview NSIS installer hooks
; Keep the existing Tauri identifier for upgrades and saved settings.
; Remove only shortcuts that target this installation.

!macro RemoveLegacyShortcut directory shortcutName
  !insertmacro IsShortcutTarget "${directory}\${shortcutName}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  Pop $4
  ${If} $4 = 1
    Delete "${directory}\${shortcutName}.lnk"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; Check if Visual C++ 2015-2022 Redistributable (x64) is already installed
  ReadRegDWord $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"

  ${If} $0 == 1
    DetailPrint "Visual C++ Runtime: already installed"
    Goto vcredist_done
  ${EndIf}

  DetailPrint "Downloading Visual C++ Runtime..."
  Delete "$TEMP\vc_redist.x64.exe"

  NSISdl::download "https://aka.ms/vs/17/release/vc_redist.x64.exe" "$TEMP\vc_redist.x64.exe"
  Pop $0

  ${If} $0 == "success"
    DetailPrint "Installing Visual C++ Runtime..."
    ExecWait '"$TEMP\vc_redist.x64.exe" /install /quiet /norestart' $1
    Delete "$TEMP\vc_redist.x64.exe"
  ${Else}
    MessageBox MB_ICONEXCLAMATION "Could not download Visual C++ Runtime.$\nPlease install it manually from:$\nhttps://aka.ms/vs/17/release/vc_redist.x64.exe"
  ${EndIf}

  vcredist_done:
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro RemoveLegacyShortcut "$SMPROGRAMS" "面试即答"
  !insertmacro RemoveLegacyShortcut "$DESKTOP" "面试即答"
  !insertmacro RemoveLegacyShortcut "$SMPROGRAMS" "模拟面试练习"
  !insertmacro RemoveLegacyShortcut "$DESKTOP" "模拟面试练习"
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayName" "MockInterview"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    !insertmacro RemoveLegacyShortcut "$SMPROGRAMS" "面试即答"
    !insertmacro RemoveLegacyShortcut "$DESKTOP" "面试即答"
    !insertmacro RemoveLegacyShortcut "$SMPROGRAMS" "模拟面试练习"
    !insertmacro RemoveLegacyShortcut "$DESKTOP" "模拟面试练习"
  ${EndIf}
!macroend
