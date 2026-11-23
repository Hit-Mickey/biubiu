!macro NotifyBiuBiuIconChanged PATH
  IfFileExists "${PATH}" 0 +2
    ; SHCNE_UPDATEITEM, SHCNF_PATHW | SHCNF_FLUSHNOWAIT
    System::Call 'shell32::SHChangeNotify(i 0x00002000, i 0x2005, w "${PATH}", p 0)'
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro NotifyBiuBiuIconChanged "$INSTDIR\${MAINBINARYNAME}.exe"
  !insertmacro NotifyBiuBiuIconChanged "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  !if "${STARTMENUFOLDER}" != ""
    !insertmacro NotifyBiuBiuIconChanged "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
  !endif
  !insertmacro NotifyBiuBiuIconChanged "$DESKTOP\${PRODUCTNAME}.lnk"
!macroend
