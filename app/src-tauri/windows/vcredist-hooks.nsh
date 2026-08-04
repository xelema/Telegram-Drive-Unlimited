!macro NSIS_HOOK_POSTINSTALL
  SetRegView 64
  ClearErrors
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"

  ${If} $0 != 1
    SetRegView 32
    ClearErrors
    ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
    SetRegView 64
  ${EndIf}

  ${If} $0 == 1
    DetailPrint "Microsoft Visual C++ runtime is already installed."
    Delete "$INSTDIR\resources\vc_redist.x64.exe"
    Goto telegram_drive_vcredist_done
  ${EndIf}

  ${IfNot} ${FileExists} "$INSTDIR\resources\vc_redist.x64.exe"
    MessageBox MB_ICONSTOP|MB_OK "Telegram Drive requires the Microsoft Visual C++ 2015-2022 Runtime, but the bundled installer is missing. Please reinstall Telegram Drive."
    SetErrors
    SetErrorLevel 1
    Goto telegram_drive_vcredist_done
  ${EndIf}

  DetailPrint "Installing Microsoft Visual C++ 2015-2022 Runtime..."
  CopyFiles /SILENT "$INSTDIR\resources\vc_redist.x64.exe" "$TEMP\telegram-drive-vc-redist.exe"
  ExecWait '"$TEMP\telegram-drive-vc-redist.exe" /install /quiet /norestart /log "$TEMP\telegram-drive-vc-redist.log"' $0
  Delete "$TEMP\telegram-drive-vc-redist.exe"

  ${If} $0 == 0
  ${OrIf} $0 == 1638
    DetailPrint "Microsoft Visual C++ runtime installation completed."
    Delete "$INSTDIR\resources\vc_redist.x64.exe"
  ${ElseIf} $0 == 3010
    DetailPrint "Microsoft Visual C++ runtime installation completed; Windows must restart."
    SetRebootFlag true
    Delete "$INSTDIR\resources\vc_redist.x64.exe"
  ${Else}
    MessageBox MB_ICONSTOP|MB_OK "Microsoft Visual C++ 2015-2022 Runtime could not be installed (error $0). Telegram Drive cannot start without it. The installer log is at $TEMP\telegram-drive-vc-redist.log."
    SetErrors
    SetErrorLevel $0
  ${EndIf}

telegram_drive_vcredist_done:
!macroend
